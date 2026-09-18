import pg from 'pg';
import { logger } from '../lib/logger.js';
import type { Store } from './store.js';
import { emptyDatabase, type DatabaseShape } from './types.js';

/**
 * Postgres-backed store for serverless deploys.
 *
 * It keeps the JsonStore contract exactly - one serialised read-modify-write
 * per transaction - so the repository and everything above it are unchanged.
 * Each collection (leads, outbox, ...) is one JSONB row. A transaction locks
 * every row with SELECT ... FOR UPDATE, which serialises writers across ALL
 * function instances, not just within one process. That is what keeps the
 * idempotency check and the outbox claim correct when Vercel runs several
 * copies of the API at once.
 *
 * Only collections whose contents changed are written back, so the common
 * case (one event appended) does not rewrite the lead table.
 *
 * TRADE-OFF: every transaction reads the whole dataset. That is comfortable up
 * to tens of thousands of events; beyond that, move to normalised tables
 * behind the same repository functions.
 */

type CollectionName = keyof DatabaseShape;

const COLLECTIONS = Object.keys(emptyDatabase()) as CollectionName[];

export class PgStore implements Store {
  private readonly pool: pg.Pool;
  private schemaReady: Promise<void> | null = null;
  /** Serialises this instance's transactions so they queue locally, not on the pool. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      // Serverless instances are many and short-lived: keep each one's
      // footprint small and let idle connections go quickly.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    this.pool.on('error', (error) => logger.error('store.pg_pool_error', { error }));
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS funnel_store (
            collection TEXT PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          )`);
        const empty = emptyDatabase();
        for (const name of COLLECTIONS) {
          await this.pool.query(
            'INSERT INTO funnel_store (collection, data) VALUES ($1, $2::jsonb) ON CONFLICT (collection) DO NOTHING',
            [name, JSON.stringify(empty[name])],
          );
        }
        logger.info('store.pg_ready');
      })().catch((error) => {
        // Let the next call try again instead of caching the failure forever.
        this.schemaReady = null;
        throw error;
      });
    }
    return this.schemaReady;
  }

  private static assemble(rows: { collection: string; data: unknown }[]): {
    db: DatabaseShape;
    before: Map<string, string>;
  } {
    const db = emptyDatabase() as unknown as Record<string, unknown>;
    const before = new Map<string, string>();
    for (const row of rows) {
      db[row.collection] = row.data;
      before.set(row.collection, JSON.stringify(row.data));
    }
    return { db: db as unknown as DatabaseShape, before };
  }

  async transaction<T>(fn: (db: DatabaseShape) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.ensureSchema();
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        // ORDER BY gives every transaction the same lock order: no deadlocks.
        const { rows } = await client.query<{ collection: string; data: unknown }>(
          'SELECT collection, data FROM funnel_store ORDER BY collection FOR UPDATE',
        );
        const { db, before } = PgStore.assemble(rows);

        const result = await fn(db);

        for (const name of COLLECTIONS) {
          const after = JSON.stringify(db[name]);
          if (after !== before.get(name)) {
            await client.query(
              'UPDATE funnel_store SET data = $2::jsonb, updated_at = now() WHERE collection = $1',
              [name, after],
            );
          }
        }

        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });

    this.queue = run.catch(() => undefined);
    return run;
  }

  async read<T>(fn: (db: DatabaseShape) => T): Promise<T> {
    await this.ensureSchema();
    const { rows } = await this.pool.query<{ collection: string; data: unknown }>(
      'SELECT collection, data FROM funnel_store',
    );
    return fn(PgStore.assemble(rows).db);
  }

  async reset(): Promise<void> {
    await this.transaction((db) => {
      Object.assign(db, emptyDatabase());
    });
  }
}
