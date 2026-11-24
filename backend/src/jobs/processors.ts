// Job processors. Thin wrappers over idempotent service methods so they can be invoked
// by BullMQ, by tests, or manually, with identical behaviour.
import type { Job } from 'bullmq';
import { JOBS } from '../platform/queue/index.js';
import { logger } from '../platform/logger.js';
import { bookingsService } from '../modules/bookings/service.js';
import { subscriptionsService } from '../modules/subscriptions/service.js';
import { paymentsService } from '../modules/payments/service.js';

export async function processBookingJob(job: Job<{ bookingId?: string }>): Promise<unknown> {
  if (job.name === JOBS.expireBookingRequest && job.data.bookingId) {
    return { expired: await bookingsService.expire(job.data.bookingId) };
  }
  throw new Error(`unknown bookings job: ${job.name}`);
}

export async function processSchedulerJob(job: Job): Promise<unknown> {
  switch (job.name) {
    case JOBS.sweepExpiredRequests: return { expired: await bookingsService.expireOverdue() };
    case JOBS.autoCompleteBookings: return { completed: await bookingsService.autoComplete() };
    case JOBS.subscriptionsTick: {
      const counts = await subscriptionsService.runLifecycle();
      const autoRenewed = await paymentsService.chargeDueAutoRenewals();
      if (Object.values(counts).some((n) => n > 0) || autoRenewed) logger.info({ ...counts, autoRenewed }, 'subscription lifecycle tick');
      return { ...counts, autoRenewed };
    }
    case JOBS.reconcilePayments: return paymentsService.reconcilePending();
    default: throw new Error(`unknown scheduler job: ${job.name}`);
  }
}

/** Repeatable schedules (BullMQ job schedulers are upserted, so restarts don't duplicate them). */
export const SCHEDULES = [
  { name: JOBS.sweepExpiredRequests, every: 5 * 60_000 },
  { name: JOBS.autoCompleteBookings, every: 60 * 60_000 },
  { name: JOBS.subscriptionsTick, every: 15 * 60_000 },
  { name: JOBS.reconcilePayments, every: 10 * 60_000 },
] as const;
