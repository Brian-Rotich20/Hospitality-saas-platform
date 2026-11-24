// Worker process: BullMQ consumers, repeatable schedules and the outbox dispatcher.
// Run one or more instances alongside the API (`npm run start:worker`). The runtime itself
// lives in jobs/runtime.ts; this file only wires process signals and connections.
import { logger } from './platform/logger.js';
import { closeQueues } from './platform/queue/index.js';
import { closeRedis } from './platform/cache/redis.js';
import { closeDatabase } from './platform/database/client.js';
import { startWorkerRuntime } from './jobs/runtime.js';

async function main() {
  const runtime = await startWorkerRuntime();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, workerId: runtime.workerId }, 'worker shutting down: finishing active jobs');
    const force = setTimeout(() => {
      logger.error('worker shutdown timed out; exiting (unfinished jobs will be retried as stalled)');
      process.exit(1);
    }, 30_000);
    force.unref();
    await runtime.stop();
    await closeQueues();
    await closeDatabase();
    await closeRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
