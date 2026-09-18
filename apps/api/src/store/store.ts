import { databaseUrl, isTest } from '../config/env.js';
import { JsonStore } from './jsonStore.js';
import { PgStore } from './pgStore.js';
import type { DatabaseShape } from './types.js';

/**
 * The storage contract the repository is written against.
 *
 * `transaction` is the only way to mutate state and must run exclusively:
 * the idempotency check and the outbox claim depend on no two transactions
 * interleaving a read-modify-write.
 */
export interface Store {
  transaction<T>(fn: (db: DatabaseShape) => T | Promise<T>): Promise<T>;
  read<T>(fn: (db: DatabaseShape) => T): Promise<T>;
  reset(): Promise<void>;
}

/**
 * Postgres when a database is configured (required on serverless), otherwise
 * the local JSON file. Tests always use the in-memory JSON store.
 */
export const store: Store = databaseUrl && !isTest ? new PgStore(databaseUrl) : new JsonStore();
