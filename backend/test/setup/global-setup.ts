// Starts disposable PostgreSQL + Redis containers, applies every migration from an empty
// database (this is the migration verification step), and exposes connection settings to
// test workers through environment variables.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';

let pg: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;

export async function setup(): Promise<void> {
  [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').withDatabase('linkmart_test').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);
  const databaseUrl = pg.getConnectionUri();

  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: path.resolve('src/platform/database/migrations') });
  await client.end();

  Object.assign(process.env, testEnv(databaseUrl, `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`));
}

export async function teardown(): Promise<void> {
  await Promise.allSettled([pg?.stop(), redis?.stop()]);
}

export function testEnv(databaseUrl: string, redisUrl: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    QUEUE_PREFIX: 'linkmart-test',
    API_PUBLIC_URL: 'http://localhost:3000',
    FRONTEND_URL: 'http://localhost:5173',
    CORS_ORIGINS: 'http://localhost:5173',
    COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123',
    BETTER_AUTH_SECRET: 'test-better-auth-secret-0123456789abcdef',
    BETTER_AUTH_URL: 'http://localhost:3000',
    MAIL_TRANSPORT: 'memory',
    RATE_LIMIT_ENABLED: 'false',
    // The OpenAPI document is generated in tests to keep docs/api/openapi.json honest.
    SWAGGER_ENABLED: 'true',
    STORAGE_PROVIDER: 'cloudinary',
    PAYSTACK_ENABLED: 'true',
    PAYSTACK_SECRET_KEY: 'sk_test_linkmart_webhook_secret',
    PAYSTACK_RECURRING_ENABLED: 'true',
    DARAJA_ENABLED: 'true',
    DARAJA_CONSUMER_KEY: 'test-consumer-key',
    DARAJA_CONSUMER_SECRET: 'test-consumer-secret',
    DARAJA_SHORTCODE: '174379',
    DARAJA_PASSKEY: 'test-passkey',
    DARAJA_CALLBACK_TOKEN: 'cb_test_token_0123456789abcdef',
  };
}
