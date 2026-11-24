// Worker runtime: BullMQ consumers, repeatable schedules, the outbox dispatcher loop and a
// liveness heartbeat. Separate from src/worker.ts (process wiring) so it can be started and
// stopped in tests.
//
// Recovery model:
//  - Delayed jobs and schedules live in Redis and survive worker restarts.
//  - A job whose worker died is detected as stalled by BullMQ and handed to another worker.
//  - Failed jobs retry with backoff (attempts per job options), then stay in the failed set
//    for 7 days: see GET /api/admin/operations/queues/:queue/failed.
//  - Outbox rows are leased, so a dead worker's rows are retried after the lease.
//  - Every processor is idempotent and re-checks state under row locks, so duplicate or
//    concurrent execution of the same logical operation is safe.
import { Worker, type Job } from 'bullmq';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { env } from '../platform/config/env.js';
import { logger } from '../platform/logger.js';
import { QUEUES, getSchedulerQueue, recordWorkerHeartbeat, removeWorkerHeartbeat } from '../platform/queue/index.js';
import { queueConnection } from '../platform/cache/redis.js';
import { processBookingJob, processSchedulerJob, SCHEDULES } from './processors.js';
import { dispatchOutbox } from '../modules/notifications/dispatcher.js';

export interface WorkerRuntime {
  readonly workerId: string;
  readonly workers: readonly Worker[];
  /** Stop taking work, let active jobs and the current outbox batch finish, then resolve. */
  stop(): Promise<void>;
}

export interface WorkerRuntimeOptions {
  /** Upsert the repeatable schedules (true in production; tests drive processors directly). */
  schedules?: boolean;
  outboxIdleMs?: number;
  heartbeatMs?: number;
}

function observe(w: Worker): void {
  w.on('completed', (job: Job, result: unknown) => {
    logger.info({ queue: w.name, job: job.name, id: job.id, durationMs: (job.finishedOn ?? Date.now()) - (job.processedOn ?? job.timestamp), result }, 'job completed');
  });
  w.on('failed', (job: Job | undefined, err: Error) => {
    const final = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : true;
    logger[final ? 'error' : 'warn']({ queue: w.name, job: job?.name, id: job?.id, attemptsMade: job?.attemptsMade, final, err: err.message },
      final ? 'job failed permanently; kept in the failed set for operators' : 'job failed; will retry');
  });
  w.on('stalled', (jobId: string) => logger.warn({ queue: w.name, id: jobId }, 'job stalled (worker lost); it will be retried'));
  // Without an 'error' listener an emitted error would crash the process.
  w.on('error', (err: Error) => logger.error({ queue: w.name, err: err.message }, 'worker error'));
}

export async function startWorkerRuntime(opts: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const outboxIdleMs = opts.outboxIdleMs ?? 2_000;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  const workers = [
    new Worker(QUEUES.bookings, processBookingJob, { prefix: env.QUEUE_PREFIX, connection: queueConnection(), concurrency: 5 }),
    new Worker(QUEUES.scheduler, processSchedulerJob, { prefix: env.QUEUE_PREFIX, connection: queueConnection(), concurrency: 1 }),
  ];
  workers.forEach(observe);

  if (opts.schedules ?? true) {
    const scheduler = getSchedulerQueue();
    for (const s of SCHEDULES) await scheduler.upsertJobScheduler(s.name, { every: s.every }, { name: s.name, data: {} });
  }

  let stopping = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(() => { wake = null; resolve(); }, ms);
    wake = () => { clearTimeout(t); wake = null; resolve(); };
  });

  const outboxLoop = (async () => {
    while (!stopping) {
      try {
        const claimed = await dispatchOutbox(25);
        if (claimed === 0) await sleep(outboxIdleMs);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'outbox dispatch failed');
        await sleep(5_000);
      }
    }
  })();

  await recordWorkerHeartbeat(workerId);
  const heartbeat = setInterval(() => { void recordWorkerHeartbeat(workerId); }, heartbeatMs);
  heartbeat.unref();

  logger.info({ workerId, schedules: (opts.schedules ?? true) ? SCHEDULES.map((s) => s.name) : [] }, 'worker started');

  let stopped: Promise<void> | null = null;
  return {
    workerId,
    workers,
    stop() {
      stopped ??= (async () => {
        stopping = true;
        clearInterval(heartbeat);
        wake?.();
        await Promise.allSettled(workers.map((w) => w.close()));
        await outboxLoop;
        await removeWorkerHeartbeat(workerId);
        logger.info({ workerId }, 'worker stopped');
      })();
      return stopped;
    },
  };
}
