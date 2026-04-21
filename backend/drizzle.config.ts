/// <reference types="node" />
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

// 🔍 Debug: confirm which database you're connecting to
console.log("DB:", process.env.DATABASE_URL);

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});