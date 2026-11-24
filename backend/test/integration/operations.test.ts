// Phase 5: background jobs, notification delivery and operational recovery, against real
// PostgreSQL, Redis and BullMQ (a live worker runtime is started in this file).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  call, db, json, makeAdmin, makeCustomer, makeListing, makeVendor, memoryMailer, requestBooking, type Actor,
} from '../helpers/app.js';
import { dispatchOutbox, OUTBOX_MAX_ATTEMPTS } from '../../src/modules/notifications/dispatcher.js';
import { enqueueOutbox } from '../../src/modules/notifications/outbox.js';
import { bookingsService } from '../../src/modules/bookings/service.js';
import { subscriptionsService } from '../../src/modules/subscriptions/service.js';
import { startWorkerRuntime, type WorkerRuntime } from '../../src/jobs/runtime.js';
import { getBookingsQueue } from '../../src/platform/queue/index.js';
import { redis } from '../../src/platform/cache/redis.js';
import { withTransaction } from '../../src/platform/database/client.js';
import { auditLog, outbox } from '../../src/platform/database/schema/platform.js';
import { bookings } from '../../src/platform/database/schema/bookings.js';
import { users } from '../../src/platform/database/schema/users.js';

let admin: Actor;
let vendor: Actor & { vendorId: string };
let vendorEmail: string;

async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 15_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function drain() {
  while ((await dispatchOutbox(100)) > 0) { /* drain everything due */ }
}

const outboxRow = async (id: string) => (await db.query.outbox.findFirst({ where: eq(outbox.id, id) }))!;

async function insertOutbox(topic: string, payload: Record<string, unknown>, extra: Partial<typeof outbox.$inferInsert> = {}) {
  const [row] = await db.insert(outbox).values({ topic, payload, availableAt: new Date(0), ...extra }).returning();
  return row!;
}

beforeAll(async () => {
  admin = await makeAdmin();
  vendor = await makeVendor('Ops Vendor');
  vendorEmail = (await db.query.users.findFirst({ where: eq(users.id, vendor.userId), columns: { email: true } }))!.email;
  await drain();
});

describe('transactional outbox delivery', () => {
  it('a partially delivered multi-recipient notification resumes without re-sending earlier emails', async () => {
    const listingId = await makeListing(vendor);
    const customer = await makeCustomer();
    const bookingId = json(await requestBooking(customer, listingId, 200, 201)).data.id as string;
    await drain();
    await db.update(bookings).set({ respondBy: new Date(Date.now() - 1000) }).where(eq(bookings.id, bookingId));
    expect(await bookingsService.expire(bookingId)).toBe(true);
    const [row] = await db.select().from(outbox).where(and(eq(outbox.topic, 'booking.expired'), sql`${outbox.payload}->>'bookingId' = ${bookingId}`));
    expect(row).toBeTruthy();

    memoryMailer.clear();
    let sends = 0;
    const spy = vi.spyOn(memoryMailer, 'send').mockImplementation((m) => {
      sends++;
      if (sends === 2) return Promise.reject(new Error('smtp unavailable'));
      memoryMailer.sent.push(m);
      return Promise.resolve();
    });
    await dispatchOutbox(10);
    spy.mockRestore();

    const afterFailure = await outboxRow(row!.id);
    expect(afterFailure).toMatchObject({ deliveredCount: 1, processedAt: null, failedAt: null, attempts: 1, lastError: 'smtp unavailable' });
    expect(afterFailure.availableAt.getTime()).toBeGreaterThan(Date.now());

    await db.update(outbox).set({ availableAt: new Date(0) }).where(eq(outbox.id, row!.id));
    await dispatchOutbox(10);
    const done = await outboxRow(row!.id);
    expect(done.processedAt).toBeTruthy();
    expect(done.deliveredCount).toBe(2);
    const expiredMails = memoryMailer.sent.filter((m) => m.tag === 'booking.expired');
    expect(expiredMails.filter((m) => m.to === customer.email)).toHaveLength(1);
    expect(expiredMails.filter((m) => m.to === vendorEmail)).toHaveLength(1);
  });

  it('an undeliverable notification is dead-lettered at once and can be retried by an admin', async () => {
    const row = await insertOutbox('no.such.topic', { x: 1 });
    await dispatchOutbox(10);
    const dead = await outboxRow(row.id);
    expect(dead.failedAt).toBeTruthy();
    expect(dead.lastError).toMatch(/unknown outbox topic/);

    const list = json(await call('GET', '/api/admin/operations/outbox?state=failed&limit=100', { actor: admin })).data as { id: string }[];
    expect(list.some((r) => r.id === row.id)).toBe(true);

    const retry = await call('POST', `/api/admin/operations/outbox/${row.id}/retry`, { actor: admin });
    expect(retry.statusCode).toBe(200);
    expect(await outboxRow(row.id)).toMatchObject({ failedAt: null, attempts: 0 });
    const again = await call('POST', `/api/admin/operations/outbox/${row.id}/retry`, { actor: admin });
    expect(again.statusCode).toBe(409);
    expect((await call('POST', `/api/admin/operations/outbox/${randomUUID()}/retry`, { actor: admin })).statusCode).toBe(404);
    expect(await db.query.auditLog.findFirst({ where: and(eq(auditLog.action, 'operations.notification_retried'), eq(auditLog.entityId, row.id)) })).toBeTruthy();
    // Settle it so it doesn't linger for the rest of the file.
    await db.update(outbox).set({ processedAt: new Date() }).where(eq(outbox.id, row.id));
  });

  it('a notification that keeps failing is dead-lettered after the maximum attempts, not retried forever', async () => {
    const row = await insertOutbox('subscription.suspended', { vendorId: vendor.vendorId }, { attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    const spy = vi.spyOn(memoryMailer, 'send').mockRejectedValue(new Error('provider down'));
    await dispatchOutbox(10);
    spy.mockRestore();
    expect(await outboxRow(row.id)).toMatchObject({ attempts: OUTBOX_MAX_ATTEMPTS, processedAt: null });
    expect((await outboxRow(row.id)).failedAt).toBeTruthy();
  });

  it('concurrent dispatchers deliver each notification exactly once', async () => {
    await drain();
    memoryMailer.clear();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await insertOutbox('subscription.suspended', { vendorId: vendor.vendorId })).id);
    await Promise.all([dispatchOutbox(3), dispatchOutbox(3), dispatchOutbox(3), dispatchOutbox(3)]);
    await drain();
    expect(memoryMailer.sent.filter((m) => m.tag === 'subscription.suspended' && m.to === vendorEmail)).toHaveLength(6);
    for (const id of ids) expect((await outboxRow(id)).processedAt).toBeTruthy();
  });

  it('notifications written in a transaction that rolls back never exist', async () => {
    const key = `rollback-${randomUUID()}`;
    await expect(withTransaction(async (tx) => {
      await enqueueOutbox(tx, 'subscription.suspended', { vendorId: vendor.vendorId }, { dedupeKey: key });
      throw new Error('business rule failed after the write');
    })).rejects.toThrow('business rule failed');
    expect(await db.query.outbox.findFirst({ where: eq(outbox.dedupeKey, key) })).toBeUndefined();
  });

  it('reminders are enqueued once even when the scheduler runs repeatedly (worker retries)', async () => {
    const v = await makeVendor('Reminder Co');
    const { vendorSubscriptions } = await import('../../src/platform/database/schema/subscriptions.js');
    await db.update(vendorSubscriptions).set({ trialEndsAt: new Date(Date.now() + 2 * 86_400_000) }).where(eq(vendorSubscriptions.vendorId, v.vendorId));
    await subscriptionsService.enqueueReminders(new Date());
    await subscriptionsService.enqueueReminders(new Date());
    await subscriptionsService.runLifecycle();
    const rows = await db.select().from(outbox).where(and(eq(outbox.topic, 'subscription.trial_reminder'), sql`${outbox.payload}->>'vendorId' = ${v.vendorId}`));
    expect(rows).toHaveLength(1);
  });
});

describe('live worker runtime (BullMQ)', () => {
  let runtime: WorkerRuntime;

  beforeAll(async () => {
    runtime = await startWorkerRuntime({ schedules: false, outboxIdleMs: 100, heartbeatMs: 250 });
  });
  afterAll(async () => { await runtime.stop(); });

  it('reports itself alive through the admin health endpoint', async () => {
    const res = await call('GET', '/api/admin/operations/health', { actor: admin });
    expect(res.statusCode).toBe(200);
    const h = json(res).data;
    expect(h).toMatchObject({ database: true, redis: true, alive: true });
    expect((h.workers as { id: string }[]).some((w) => w.id === runtime.workerId)).toBe(true);
    expect(h.queues).toEqual(expect.arrayContaining([expect.objectContaining({ queue: 'bookings' }), expect.objectContaining({ queue: 'scheduler' })]));
  });

  it('runs the delayed 24-hour expiry job for a booking request', async () => {
    const listingId = await makeListing(vendor);
    const customer = await makeCustomer();
    const bookingId = json(await requestBooking(customer, listingId, 210, 211)).data.id as string;
    const job = await getBookingsQueue().getJob(`expire-${bookingId}`);
    expect(job).toBeTruthy();
    expect(await job!.getState()).toBe('delayed');
    // Time travel: the deadline has passed, and the delayed job becomes due.
    await db.update(bookings).set({ respondBy: new Date(Date.now() - 1000) }).where(eq(bookings.id, bookingId));
    await job!.promote();
    await until(async () => (await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) }))?.status === 'expired');
    // Scheduling again for the same booking is a no-op (deterministic job id).
    await getBookingsQueue().add('booking.expire-request', { bookingId }, { jobId: `expire-${bookingId}` });
    expect((await getBookingsQueue().getJobs(['waiting', 'delayed', 'active'])).filter((j) => j.id === `expire-${bookingId}`)).toHaveLength(0);
  });

  it('a failing job is retried with backoff, then kept in the failed set where an admin can inspect and retry it', async () => {
    const job = await getBookingsQueue().add('bogus.job', { note: 'test' }, { attempts: 2, backoff: { type: 'fixed', delay: 50 } });
    await until(async () => (await job.getState()) === 'failed');
    const failed = json(await call('GET', '/api/admin/operations/queues/bookings/failed?limit=100', { actor: admin })).data as { id: string; attemptsMade: number; failedReason: string }[];
    const mine = failed.find((f) => f.id === job.id);
    expect(mine).toMatchObject({ attemptsMade: 2 });
    expect(mine!.failedReason).toMatch(/unknown bookings job/);

    const retry = await call('POST', `/api/admin/operations/queues/bookings/jobs/${job.id}/retry`, { actor: admin });
    expect(retry.statusCode).toBe(200);
    expect(await db.query.auditLog.findFirst({ where: and(eq(auditLog.action, 'operations.job_retried'), eq(auditLog.entityId, `bookings:${job.id}`)) })).toBeTruthy();
    await until(async () => (await job.getState()) === 'failed'); // still unknown, fails again
    expect((await call('POST', `/api/admin/operations/queues/bookings/jobs/missing-${randomUUID()}/retry`, { actor: admin })).statusCode).toBe(404);
  });

  it('only failed jobs can be retried', async () => {
    const job = await getBookingsQueue().add('booking.expire-request', { bookingId: randomUUID() }, { delay: 60 * 60_000 });
    const res = await call('POST', `/api/admin/operations/queues/bookings/jobs/${job.id}/retry`, { actor: admin });
    expect(res.statusCode).toBe(409);
    await job.remove();
  });

  it('delivers outbox notifications from its dispatcher loop', async () => {
    const row = await insertOutbox('subscription.suspended', { vendorId: vendor.vendorId });
    await until(async () => (await outboxRow(row.id)).processedAt);
  });

  it('shuts down gracefully: workers closed, loop stopped, heartbeat removed', async () => {
    await runtime.stop();
    expect(runtime.workers.every((w) => !w.isRunning())).toBe(true);
    await expect(runtime.stop()).resolves.toBeUndefined(); // idempotent
    const h = json(await call('GET', '/api/admin/operations/health', { actor: admin })).data;
    expect((h.workers as { id: string }[]).some((w) => w.id === runtime.workerId)).toBe(false);
  });
});

describe('Redis failure handling', () => {
  it('the API keeps serving from the database while the cache connection is down', async () => {
    redis.disconnect();
    try {
      const res = await call('GET', '/api/categories');
      expect(res.statusCode).toBe(200);
      const ready = await call('GET', '/ready');
      expect(ready.statusCode).toBe(200);
      expect(json(ready)).toMatchObject({ database: true, redis: false });
      const listing = await call('GET', '/api/listings');
      expect(listing.statusCode).toBe(200);
    } finally {
      await redis.connect();
    }
    expect(json(await call('GET', '/ready')).redis).toBe(true);
  });
});

describe('operations endpoints are admin-only', () => {
  it('rejects anonymous, customer and vendor callers', async () => {
    for (const path of ['/api/admin/operations/health', '/api/admin/operations/outbox', '/api/admin/operations/audit', '/api/admin/operations/queues/bookings/failed']) {
      expect((await call('GET', path)).statusCode).toBe(401);
      expect((await call('GET', path, { actor: await makeCustomer() })).statusCode).toBe(403);
      expect((await call('GET', path, { actor: vendor })).statusCode).toBe(403);
    }
  });

  it('the audit log can be queried by entity', async () => {
    const res = await call('GET', `/api/admin/operations/audit?entityType=vendor&entityId=${vendor.vendorId}`, { actor: admin });
    expect(res.statusCode).toBe(200);
    const rows = json(res).data as { action: string; entityId: string }[];
    expect(rows.some((r) => r.action === 'vendor.onboarded')).toBe(true);
    expect(rows.every((r) => r.entityId === vendor.vendorId)).toBe(true);
  });
});
