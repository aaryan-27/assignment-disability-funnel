import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, isTest } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { emptyDatabase, type DatabaseShape } from './types.js';

/**
 * A tiny durable store.
 *
 * TRADE-OFF (documented in the README): a JSON file is not a production
 * database. It is here so the whole reliability architecture - outbox, retries,
 * dead letters, idempotency - can be demonstrated on a laptop with zero infra.
 * Everything above this file talks to the repository interface, so swapping in
 * Postgres is a single-module change and no business logic moves.
 *
 * Two properties are still honoured, because the correctness of the outbox
 * depends on them:
 *   1. Writes are serialised through a promise chain (no lost updates).
 *   2. Writes are atomic (temp file + rename), so a crash mid-write cannot
 *      leave a truncated database behind.
 */

const DB_FILENAME = 'funnel-db.json';

/**
 * Repo root, derived from this module's own location.
 *
 * A relative DATA_DIR must NOT resolve against process.cwd(): `npm run dev:api`
 * runs with cwd=apps/api while `node apps/api/dist/index.js` runs from the root,
 * so the same config would silently point at two different databases. Anchoring
 * to the module keeps the path identical however the server is launched. An
 * absolute DATA_DIR is honoured as given, which is what a container would set.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function resolveDataDir(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.resolve(REPO_ROOT, dir);
}

class JsonStore {
  private data: DatabaseShape = emptyDatabase();
  private loaded = false;
  /** Serialises all mutations; every transaction appends to this chain. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;
  private readonly persistent: boolean;

  constructor() {
    this.filePath = path.join(resolveDataDir(env.DATA_DIR), DB_FILENAME);
    // Tests run fully in memory: fast, parallel-safe, no cleanup required.
    this.persistent = !isTest;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;

    if (!this.persistent) {
      this.data = emptyDatabase();
      this.loaded = true;
      return;
    }

    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DatabaseShape>;
      // Merge over a fresh shape so a store written by an older version that
      // lacks a table still boots.
      this.data = { ...emptyDatabase(), ...parsed };
      logger.info('store.loaded', {
        path: this.filePath,
        leads: this.data.leads.length,
        outbox: this.data.outbox.length,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.error('store.load_failed', { error, path: this.filePath });
      }
      this.data = emptyDatabase();
    }

    this.loaded = true;
  }

  private async flush(): Promise<void> {
    if (!this.persistent) return;
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    // rename(2) is atomic within a filesystem: readers never see a partial file.
    await fs.rename(tmp, this.filePath);
  }

  /**
   * Run `fn` with exclusive access to the database, then persist.
   *
   * This is the only way to mutate state. Because every caller awaits the same
   * chain, two concurrent lead submissions cannot interleave a read-modify-write
   * and lose one of the writes - which is exactly the bug that would otherwise
   * let a duplicate slip past the idempotency check.
   */
  async transaction<T>(fn: (db: DatabaseShape) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.load();
      const result = await fn(this.data);
      await this.flush();
      return result;
    });

    // Keep the chain alive even if this transaction rejects.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Read-only access. Still serialised so reads never observe a torn state. */
  async read<T>(fn: (db: DatabaseShape) => T): Promise<T> {
    const run = this.queue.then(async () => {
      await this.load();
      return fn(this.data);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Test helper: wipe everything. */
  async reset(): Promise<void> {
    await this.transaction((db) => {
      db.leads = [];
      db.qualification = [];
      db.events = [];
      db.automation_runs = [];
      db.outbox = [];
      db.idempotency = [];
      db.counters = {};
    });
  }
}

export const store = new JsonStore();
