/// <reference types="node" />
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// Migrations are the only supported way to change the schema. `drizzle-kit push` is
// intentionally not exposed as a script (see docs/refactor/PHASE-0-REPORT.md).
export default defineConfig({
  schema: './src/platform/database/schema/index.ts',
  out: './src/platform/database/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
});
