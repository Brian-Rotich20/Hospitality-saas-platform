// Operational visibility and recovery for administrators: queue health, failed jobs,
// dead-lettered notifications, and the audit log. Recovery actions only re-run work the
// system already decided to do (retry a job, retry a notification); they never change
// business state directly.
import { and, count, desc, eq, gte, isNotNull, isNull, lte, min, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/database/client.js';
import { auditLog, outbox } from '../../platform/database/schema/platform.js';
import { paymentAttempts, providerEvents } from '../../platform/database/schema/subscriptions.js';
import { QUEUES, describeJob, getQueue, liveWorkers, queueStats, withQueueTimeout, type QueueName } from '../../platform/queue/index.js';
import { pingDatabase } from '../../platform/database/client.js';
import { pingRedis } from '../../platform/cache/redis.js';
import { recordAudit } from '../../app/audit.js';
import { SENSITIVE_OUTBOX_TOPICS } from '../notifications/outbox.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../../app/errors.js';

async function orUnavailable<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    throw new ServiceUnavailableError(`Queue backend unavailable: ${(err as Error).message}`, 'QUEUE_UNAVAILABLE');
  }
}

export const operationsService = {
  /** One-page health view. Degrades per section: a Redis outage still shows database-backed numbers. */
  async health() {
    const [database, redisOk] = await Promise.all([pingDatabase(), pingRedis()]);
    const queues = await Promise.all(Object.values(QUEUES).map(async (q) => {
      try { return await queueStats(q); } catch (err) { return { queue: q, error: (err as Error).message }; }
    }));
    let workers: { id: string; lastSeenAt: string }[] | { error: string };
    try { workers = await liveWorkers(); } catch (err) { workers = { error: (err as Error).message }; }

    const [[pending], [dead], [unprocessedEvents], [reviews]] = await Promise.all([
      db.select({ n: count(), oldest: min(outbox.createdAt) }).from(outbox).where(and(isNull(outbox.processedAt), isNull(outbox.failedAt))),
      db.select({ n: count() }).from(outbox).where(and(isNull(outbox.processedAt), isNotNull(outbox.failedAt))),
      db.select({ n: count() }).from(providerEvents).where(isNull(providerEvents.processedAt)),
      db.select({ n: count() }).from(paymentAttempts).where(and(eq(paymentAttempts.requiresReview, true), isNull(paymentAttempts.reviewedAt))),
    ]);
    return {
      database, redis: redisOk, queues, workers,
      alive: Array.isArray(workers) && workers.length > 0,
      outbox: { pending: pending?.n ?? 0, oldestPendingAt: pending?.oldest ?? null, deadLettered: dead?.n ?? 0 },
      payments: { unprocessedProviderEvents: unprocessedEvents?.n ?? 0, awaitingReview: reviews?.n ?? 0 },
    };
  },

  async failedJobs(queue: QueueName, limit: number, offset: number) {
    const jobs = await orUnavailable(withQueueTimeout(getQueue(queue).getFailed(offset, offset + limit - 1), 'list failed jobs'));
    return jobs.map(describeJob);
  },

  async retryJob(queue: QueueName, jobId: string, adminUserId: string, requestId?: string) {
    const job = await orUnavailable(withQueueTimeout(getQueue(queue).getJob(jobId), 'get job'));
    if (!job) throw new NotFoundError('Job');
    const state = await orUnavailable(withQueueTimeout(job.getState(), 'job state'));
    if (state !== 'failed') throw new ConflictError(`Only failed jobs can be retried (this job is ${state})`, 'INVALID_TRANSITION');
    await orUnavailable(withQueueTimeout(job.retry(), 'retry job'));
    await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: 'operations.job_retried', entityType: 'queue_job', entityId: `${queue}:${jobId}`, details: { name: job.name, attemptsMade: job.attemptsMade }, requestId });
    return describeJob(job);
  },

  async listOutbox(f: { state: 'failed' | 'pending' | 'retrying'; topic?: string | undefined; limit: number; offset: number }) {
    const conds: SQL[] = [isNull(outbox.processedAt)];
    if (f.state === 'failed') conds.push(isNotNull(outbox.failedAt));
    else conds.push(isNull(outbox.failedAt));
    if (f.state === 'retrying') conds.push(sql`${outbox.attempts} > 0`);
    if (f.topic) conds.push(eq(outbox.topic, f.topic));
    const rows = await db.select({
      id: outbox.id, topic: outbox.topic, payload: outbox.payload, attempts: outbox.attempts, deliveredCount: outbox.deliveredCount,
      lastError: outbox.lastError, availableAt: outbox.availableAt, failedAt: outbox.failedAt, createdAt: outbox.createdAt,
    }).from(outbox).where(and(...conds)).orderBy(desc(outbox.createdAt)).limit(f.limit).offset(f.offset);
    // Never expose credentials (e.g. password-reset tokens) to operators.
    return rows.map((r) => (SENSITIVE_OUTBOX_TOPICS.has(r.topic) ? { ...r, payload: { redacted: true } } : r));
  },

  /** Re-queue a dead-lettered notification. Emails already sent for it are not re-sent. */
  async retryOutbox(id: string, adminUserId: string, requestId?: string) {
    const [row] = await db.update(outbox)
      .set({ failedAt: null, attempts: 0, availableAt: new Date(), lastError: null })
      .where(and(eq(outbox.id, id), isNull(outbox.processedAt), isNotNull(outbox.failedAt)))
      .returning({ id: outbox.id, topic: outbox.topic });
    if (!row) {
      const exists = await db.query.outbox.findFirst({ where: eq(outbox.id, id), columns: { id: true } });
      if (!exists) throw new NotFoundError('Notification');
      throw new ConflictError('Only dead-lettered notifications can be retried', 'INVALID_TRANSITION');
    }
    await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: 'operations.notification_retried', entityType: 'outbox', entityId: id, details: { topic: row.topic }, requestId });
    return row;
  },

  listAudit(f: { entityType?: string | undefined; entityId?: string | undefined; action?: string | undefined; actorUserId?: string | undefined; from?: Date | undefined; to?: Date | undefined; limit: number; offset: number }) {
    const conds: SQL[] = [];
    if (f.entityType) conds.push(eq(auditLog.entityType, f.entityType));
    if (f.entityId) conds.push(eq(auditLog.entityId, f.entityId));
    if (f.action) conds.push(eq(auditLog.action, f.action));
    if (f.actorUserId) conds.push(eq(auditLog.actorUserId, f.actorUserId));
    if (f.from) conds.push(gte(auditLog.createdAt, f.from));
    if (f.to) conds.push(lte(auditLog.createdAt, f.to));
    return db.select().from(auditLog).where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(auditLog.createdAt)).limit(f.limit).offset(f.offset);
  },
};
