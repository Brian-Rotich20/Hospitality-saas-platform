// BullMQ queues. The API process only enqueues; src/worker.ts consumes.
//
// Every job is idempotent: processors re-check state in the database (inside a
// transaction) before changing anything, so duplicate deliveries, retries and the
// periodic sweepers that back up delayed jobs are all safe.
//
// Queue connections wait for Redis rather than failing (BullMQ requirement), so every
// call made from a request path or an admin endpoint is bounded by a timeout.
import { Queue, type Job, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { queueConnection, redis } from '../cache/redis.js';

export const QUEUES = {
  bookings: 'bookings',
  scheduler: 'scheduler',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  expireBookingRequest: 'booking.expire-request',
  sweepExpiredRequests: 'booking.sweep-expired-requests',
  autoCompleteBookings: 'booking.auto-complete',
  subscriptionsTick: 'subscriptions.tick',
  reconcilePayments: 'payments.reconcile-pending',
} as const;

const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  // Failed jobs are kept for a week so operators can inspect and retry them.
  removeOnFail: { age: 7 * 24 * 3600 },
};

let bookingsQueue: Queue | undefined;
let schedulerQueue: Queue | undefined;

export function getBookingsQueue(): Queue {
  bookingsQueue ??= new Queue(QUEUES.bookings, { connection: queueConnection(), prefix: env.QUEUE_PREFIX, defaultJobOptions });
  return bookingsQueue;
}

export function getSchedulerQueue(): Queue {
  schedulerQueue ??= new Queue(QUEUES.scheduler, { connection: queueConnection(), prefix: env.QUEUE_PREFIX, defaultJobOptions });
  return schedulerQueue;
}

export function getQueue(name: QueueName): Queue {
  return name === QUEUES.bookings ? getBookingsQueue() : getSchedulerQueue();
}

export class QueueTimeoutError extends Error {
  constructor(what: string) { super(`queue operation timed out: ${what}`); this.name = 'QueueTimeoutError'; }
}

/** Bound a queue call: Redis being down must not hang a request. */
export function withQueueTimeout<T>(p: Promise<T>, what: string, ms = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new QueueTimeoutError(what)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

/**
 * Schedule the 24-hour expiry of a booking request. The job id is derived from the
 * booking id, so scheduling twice is a no-op. Failure to enqueue (including Redis being
 * unreachable) is logged, not thrown: the periodic sweeper expires overdue requests
 * anyway, and acceptance enforces the deadline in the service layer regardless.
 */
export async function scheduleBookingExpiry(bookingId: string, respondBy: Date): Promise<void> {
  try {
    const delay = Math.max(0, respondBy.getTime() - Date.now());
    await withQueueTimeout(getBookingsQueue().add(JOBS.expireBookingRequest, { bookingId }, { jobId: `expire-${bookingId}`, delay }), 'schedule booking expiry');
  } catch (err) {
    logger.error({ bookingId, err: (err as Error).message }, 'failed to enqueue booking expiry; sweeper will handle it');
  }
}

// ── Worker liveness ──────────────────────────────────────────────────────────
// Each worker writes a heartbeat to a sorted set (score = last seen, ms). Operators and
// the admin operations endpoint read it to confirm at least one worker is alive.
const heartbeatKey = () => `${env.QUEUE_PREFIX}:workers`;
export const HEARTBEAT_STALE_MS = 60_000;

export async function recordWorkerHeartbeat(workerId: string): Promise<void> {
  try {
    const now = Date.now();
    await withQueueTimeout(redis.zadd(heartbeatKey(), now, workerId), 'heartbeat');
    await withQueueTimeout(redis.zremrangebyscore(heartbeatKey(), 0, now - 10 * HEARTBEAT_STALE_MS), 'heartbeat prune');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'worker heartbeat failed');
  }
}

export async function removeWorkerHeartbeat(workerId: string): Promise<void> {
  try {
    await withQueueTimeout(redis.zrem(heartbeatKey(), workerId), 'heartbeat remove');
  } catch {
    // Best effort: the entry goes stale on its own.
  }
}

export async function liveWorkers(): Promise<{ id: string; lastSeenAt: string }[]> {
  const raw = await withQueueTimeout(redis.zrangebyscore(heartbeatKey(), Date.now() - HEARTBEAT_STALE_MS, '+inf', 'WITHSCORES'), 'list workers');
  const out: { id: string; lastSeenAt: string }[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) out.push({ id: raw[i] ?? '', lastSeenAt: new Date(Number(raw[i + 1])).toISOString() });
  return out;
}

// ── Inspection (admin operations) ────────────────────────────────────────────
export async function queueStats(name: QueueName) {
  const q = getQueue(name);
  const counts = await withQueueTimeout(q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized'), `${name} counts`);
  return { queue: name, counts };
}

/** Only identifiers and failure metadata: job payloads hold ids, never personal data. */
export function describeJob(job: Job) {
  return {
    id: job.id ?? null, name: job.name, attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1,
    failedReason: job.failedReason ?? null, data: job.data as unknown,
    createdAt: new Date(job.timestamp).toISOString(),
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([bookingsQueue?.close(), schedulerQueue?.close()]);
  bookingsQueue = undefined;
  schedulerQueue = undefined;
}
