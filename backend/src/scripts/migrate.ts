// Release-step migration runner (production image has no drizzle-kit).
//   node dist/scripts/migrate.js
// Applies pending migrations from src/platform/database/migrations in one transaction.
// On an existing database the baseline must first be recorded as applied; see
// docs/refactor/PHASE-0-REPORT.md. Never run against production without approval.
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
migrate(drizzle(client), { migrationsFolder: path.resolve('src/platform/database/migrations') })
  .then(async () => {
    console.log('migrations applied');
    await client.end();
  })
  .catch(async (err: unknown) => {
    console.error('migration failed:', err instanceof Error ? err.message : err);
    await client.end();
    process.exit(1);
  });
