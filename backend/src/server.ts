// API process. Background work runs in src/worker.ts (a separate process).
import { buildApp } from './app/build-app.js';
import { env } from './platform/config/env.js';
import { logger } from './platform/logger.js';
import { closeDatabase } from './platform/database/client.js';
import { closeRedis } from './platform/cache/redis.js';
import { closeQueues } from './platform/queue/index.js';

async function main() {
  const app = await buildApp();
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down API: draining requests');
    const force = setTimeout(() => { logger.error('forced exit after shutdown timeout'); process.exit(1); }, 25_000);
    force.unref();
    try {
      await app.close();          // stop accepting, finish in-flight requests
      await closeQueues();
      await closeDatabase();
      await closeRedis();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaught exception'); void shutdown('uncaughtException'); });

  await app.listen({ port: env.PORT, host: env.HOST });

  // Same-origin proxy deployments (frontend /api -> this API) need BETTER_AUTH_URL to be the
  // public frontend origin, listed in CORS_ORIGINS (Better Auth's trusted origins); see
  // docs/operations/RUNBOOK.md. A mismatch breaks Google sign-in and cookie-based sessions.
  const authOrigin = new URL(env.BETTER_AUTH_URL).origin;
  if (!env.CORS_ORIGINS.includes(authOrigin)) {
    logger.warn({ betterAuthOrigin: authOrigin }, 'BETTER_AUTH_URL origin is not in CORS_ORIGINS; with the frontend /api proxy, set BETTER_AUTH_URL to the frontend origin and list it in CORS_ORIGINS');
  }
  if (env.NODE_ENV === 'production' && env.TRUST_PROXY === false) {
    logger.warn('TRUST_PROXY=false: behind a proxy every anonymous client shares the proxy address for rate limits; set the hop count or proxy CIDRs');
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start API');
  process.exit(1);
});
