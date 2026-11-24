import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;
/** A transaction handle. Repositories accept `Db` so they work inside or outside a transaction. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Db = Database | Transaction;

const client = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: () => {},
  connection: { statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS, TimeZone: 'UTC' },
});

export const db: Database = drizzle(client, { schema });

/**
 * Run `fn` in a transaction. Nested calls reuse the outer transaction, so services can
 * compose without opening savepoints by accident.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>, outer?: Db): Promise<T> {
  if (outer && outer !== db) return fn(outer as Transaction);
  return db.transaction(fn);
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await client.end({ timeout: 5 });
}
