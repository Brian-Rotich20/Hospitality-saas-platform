// Vendor subscriptions: trial, monthly billing, grace, suspension, expiry, cancellation.
//
// State machine (status):
//   trialing --trial ends, invoice issued--> past_due --paid--> active
//   active   --period ends, invoice issued--> past_due
//   past_due --grace ends unpaid--> suspended --N days unpaid--> expired
//   suspended/expired/cancelled --paid--> active
//   trialing/active --cancel--> (cancel_at_period_end) --period/trial ends--> cancelled
//   past_due --cancel--> cancelled (open invoice voided)
// Entitled (paid functionality available): trialing, active, past_due.
// No subscription row ("legacy_unenrolled"): vendors that predate subscriptions. They
// are treated as entitled until an approved transition policy enrols them (see docs).
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db, withTransaction, type Db } from '../../platform/database/client.js';
import {
  subscriptionPlans, vendorSubscriptions, subscriptionInvoices, paymentAttempts,
} from '../../platform/database/schema/subscriptions.js';
import { vendors } from '../../platform/database/schema/vendors.js';
import { auditLog } from '../../platform/database/schema/platform.js';
import { env } from '../../platform/config/env.js';
import { addDays, addMonthsUTC } from '../../platform/time.js';
import { logger } from '../../platform/logger.js';
import { eachIsolated } from '../../platform/batch.js';
import { enqueueOutbox } from '../notifications/outbox.js';
import { recordAudit } from '../../app/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../app/errors.js';

export type SubscriptionRow = typeof vendorSubscriptions.$inferSelect;
export type SubscriptionStatus = SubscriptionRow['status'];
export type InvoiceRow = typeof subscriptionInvoices.$inferSelect;
export type PlanRow = typeof subscriptionPlans.$inferSelect;

export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ['trialing', 'active', 'past_due'];
export const RESTRICTED_STATUSES: readonly SubscriptionStatus[] = ['suspended', 'expired', 'cancelled'];

export interface Entitlement {
  entitled: boolean;
  status: SubscriptionStatus | 'legacy_unenrolled';
  subscriptionId: string | null;
}

/**
 * SQL predicate: true when vendor `vendorIdColumn` may be shown to customers and booked
 * (no subscription row, or an entitled one). Used by catalog and booking queries.
 */
export function vendorEntitledSql(vendorIdColumn: string) {
  return sql.raw(`NOT EXISTS (SELECT 1 FROM vendor_subscriptions vs WHERE vs.vendor_id = ${vendorIdColumn} AND vs.status IN ('suspended','expired','cancelled'))`);
}

async function lockSubscription(vendorId: string, tx: Db) {
  const [row] = await tx.select().from(vendorSubscriptions).where(eq(vendorSubscriptions.vendorId, vendorId)).for('update');
  return row;
}

async function activePlan(tx: Db) {
  return tx.query.subscriptionPlans.findFirst({ where: eq(subscriptionPlans.isActive, true) });
}

async function updateSub(id: string, values: Partial<typeof vendorSubscriptions.$inferInsert>, tx: Db) {
  const [row] = await tx.update(vendorSubscriptions).set({ ...values, updatedAt: new Date() }).where(eq(vendorSubscriptions.id, id)).returning();
  if (!row) throw new Error('subscription update returned no row');
  return row;
}

/** Issue (or return the existing) invoice for a billing period. Idempotent per (subscription, periodStart). */
async function issueInvoice(sub: SubscriptionRow, periodStart: Date, tx: Db): Promise<InvoiceRow | null> {
  const existing = await tx.query.subscriptionInvoices.findFirst({
    where: and(eq(subscriptionInvoices.subscriptionId, sub.id), eq(subscriptionInvoices.periodStart, periodStart)),
  });
  if (existing) return existing;
  const plan = await activePlan(tx);
  if (!plan) return null;
  const [inv] = await tx.insert(subscriptionInvoices).values({
    subscriptionId: sub.id,
    vendorId: sub.vendorId,
    planId: plan.id,
    amountMinor: plan.amountMinor,
    currency: plan.currency,
    periodStart,
    periodEnd: addMonthsUTC(periodStart, 1),
    dueAt: periodStart,
  }).onConflictDoNothing().returning();
  return inv ?? (await tx.query.subscriptionInvoices.findFirst({
    where: and(eq(subscriptionInvoices.subscriptionId, sub.id), eq(subscriptionInvoices.periodStart, periodStart)),
  })) ?? null;
}

async function openInvoices(subscriptionId: string, tx: Db) {
  return tx.query.subscriptionInvoices.findMany({
    where: and(eq(subscriptionInvoices.subscriptionId, subscriptionId), eq(subscriptionInvoices.status, 'open')),
    orderBy: [asc(subscriptionInvoices.dueAt)],
  });
}

/** Move a subscription into past_due for `invoice`, or hold billing if no plan exists. */
async function billPeriod(sub: SubscriptionRow, periodStart: Date, tx: Db) {
  const invoice = await issueInvoice(sub, periodStart, tx);
  if (!invoice) {
    if (sub.billingHoldReason !== 'no_active_plan') {
      await updateSub(sub.id, { billingHoldReason: 'no_active_plan' }, tx);
      await recordAudit({ actorType: 'system', action: 'subscription.billing_held', entityType: 'vendor_subscription', entityId: sub.id, details: { reason: 'no_active_plan' } }, tx);
      logger.warn({ subscriptionId: sub.id }, 'renewal due but no active subscription plan is configured; billing held');
    }
    return;
  }
  const graceEndsAt = addDays(invoice.dueAt, env.SUBSCRIPTION_GRACE_DAYS);
  await updateSub(sub.id, { status: 'past_due', planId: invoice.planId, graceEndsAt, billingHoldReason: null }, tx);
  await recordAudit({ actorType: 'system', action: 'subscription.invoice_issued', entityType: 'subscription_invoice', entityId: invoice.id, details: { from: sub.status, amountMinor: invoice.amountMinor, currency: invoice.currency } }, tx);
}

export const subscriptionsService = {
  // ── Entitlement ────────────────────────────────────────────────────────────
  async getEntitlement(vendorId: string, tx: Db = db): Promise<Entitlement> {
    const sub = await tx.query.vendorSubscriptions.findFirst({
      where: eq(vendorSubscriptions.vendorId, vendorId),
      columns: { id: true, status: true },
    });
    if (!sub) return { entitled: true, status: 'legacy_unenrolled', subscriptionId: null };
    return { entitled: ENTITLED_STATUSES.includes(sub.status), status: sub.status, subscriptionId: sub.id };
  },

  // ── Trial ──────────────────────────────────────────────────────────────────
  /** Start the one-month free trial. Called inside the onboarding transaction. */
  async startTrial(vendorId: string, tx: Db, opts: { now?: Date; origin?: 'onboarding' | 'admin_enrolment' } = {}) {
    const now = opts.now ?? new Date();
    const [row] = await tx.insert(vendorSubscriptions).values({
      vendorId,
      status: 'trialing',
      trialStartedAt: now,
      trialEndsAt: addMonthsUTC(now, 1),
      origin: opts.origin ?? 'onboarding',
    }).onConflictDoNothing({ target: vendorSubscriptions.vendorId }).returning();
    if (!row) throw new ConflictError('This vendor already has a subscription', 'SUBSCRIPTION_EXISTS');
    return row;
  },

  /**
   * Admin action for vendors created before subscriptions existed. Deliberately manual:
   * there is no approved transition policy for existing vendors, so nothing enrols them
   * automatically. The trial starts at the moment of enrolment.
   */
  async enrolLegacyVendor(vendorId: string, adminUserId: string, requestId?: string) {
    return withTransaction(async (tx) => {
      const vendor = await tx.query.vendors.findFirst({ where: eq(vendors.id, vendorId), columns: { id: true } });
      if (!vendor) throw new NotFoundError('Vendor');
      const sub = await this.startTrial(vendorId, tx, { origin: 'admin_enrolment' });
      await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: 'subscription.legacy_enrolled', entityType: 'vendor_subscription', entityId: sub.id, details: { vendorId }, requestId }, tx);
      return sub;
    });
  },

  // ── Vendor-facing views ────────────────────────────────────────────────────
  async getOverview(vendorId: string) {
    const sub = await db.query.vendorSubscriptions.findFirst({ where: eq(vendorSubscriptions.vendorId, vendorId) });
    const plan = await activePlan(db);
    if (!sub) {
      return { status: 'legacy_unenrolled' as const, entitled: true, subscription: null, openInvoice: null,
        currentPlan: plan ? { name: plan.name, amountMinor: plan.amountMinor, currency: plan.currency, interval: plan.interval } : null };
    }
    const [open] = await openInvoices(sub.id, db);
    return {
      status: sub.status,
      entitled: ENTITLED_STATUSES.includes(sub.status),
      subscription: {
        id: sub.id, status: sub.status, trialStartedAt: sub.trialStartedAt, trialEndsAt: sub.trialEndsAt,
        currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, graceEndsAt: sub.graceEndsAt,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd, cancelledAt: sub.cancelledAt, suspendedAt: sub.suspendedAt, expiredAt: sub.expiredAt,
        autoRenew: sub.autoRenewOptIn && sub.paystackAuthorizationCode != null, autoRenewOptIn: sub.autoRenewOptIn,
        billingHoldReason: sub.billingHoldReason,
      },
      openInvoice: open ?? null,
      currentPlan: plan ? { name: plan.name, amountMinor: plan.amountMinor, currency: plan.currency, interval: plan.interval } : null,
    };
  },

  listInvoices(vendorId: string, limit: number, offset: number) {
    return db.query.subscriptionInvoices.findMany({
      where: eq(subscriptionInvoices.vendorId, vendorId),
      orderBy: [desc(subscriptionInvoices.periodStart)], limit, offset,
    });
  },

  listPayments(vendorId: string, limit: number, offset: number) {
    return db.query.paymentAttempts.findMany({
      where: eq(paymentAttempts.vendorId, vendorId),
      columns: {
        id: true, invoiceId: true, provider: true, status: true, amountMinor: true, currency: true,
        providerReference: true, providerReceipt: true, phoneMasked: true, failureReason: true,
        initiatedBy: true, createdAt: true, completedAt: true,
      },
      orderBy: [desc(paymentAttempts.createdAt)], limit, offset,
    });
  },

  // ── Vendor actions ─────────────────────────────────────────────────────────
  async cancel(vendorId: string, userId: string, requestId?: string) {
    return withTransaction(async (tx) => {
      const sub = await lockSubscription(vendorId, tx);
      if (!sub) throw new NotFoundError('Subscription');
      if (sub.status === 'trialing' || sub.status === 'active') {
        if (sub.cancelAtPeriodEnd) return sub;
        const updated = await updateSub(sub.id, { cancelAtPeriodEnd: true }, tx);
        await recordAudit({ actorUserId: userId, actorType: 'user', action: 'subscription.cancel_scheduled', entityType: 'vendor_subscription', entityId: sub.id, requestId }, tx);
        return updated;
      }
      if (sub.status === 'past_due' || sub.status === 'suspended') {
        // Nothing paid for the current period: cancel now and stop pursuing the open invoice.
        for (const inv of await openInvoices(sub.id, tx)) {
          await tx.update(subscriptionInvoices).set({ status: 'void', voidedAt: new Date(), voidReason: 'cancelled_by_vendor' }).where(eq(subscriptionInvoices.id, inv.id));
        }
        const updated = await updateSub(sub.id, { status: 'cancelled', cancelledAt: new Date(), graceEndsAt: null }, tx);
        await recordAudit({ actorUserId: userId, actorType: 'user', action: 'subscription.cancelled', entityType: 'vendor_subscription', entityId: sub.id, details: { from: sub.status }, requestId }, tx);
        return updated;
      }
      throw new ConflictError(`Subscription is already ${sub.status}`, 'SUBSCRIPTION_NOT_CANCELLABLE');
    });
  },

  async resume(vendorId: string, userId: string, requestId?: string) {
    return withTransaction(async (tx) => {
      const sub = await lockSubscription(vendorId, tx);
      if (!sub) throw new NotFoundError('Subscription');
      if (!sub.cancelAtPeriodEnd || (sub.status !== 'trialing' && sub.status !== 'active')) {
        throw new ConflictError('There is no scheduled cancellation to undo', 'NOTHING_TO_RESUME');
      }
      const updated = await updateSub(sub.id, { cancelAtPeriodEnd: false }, tx);
      await recordAudit({ actorUserId: userId, actorType: 'user', action: 'subscription.cancel_undone', entityType: 'vendor_subscription', entityId: sub.id, requestId }, tx);
      return updated;
    });
  },

  async setAutoRenew(vendorId: string, enabled: boolean, userId: string, recurringSupported: boolean) {
    if (enabled && !recurringSupported) throw new ConflictError('Automatic card renewal is not available', 'RECURRING_NOT_AVAILABLE');
    return withTransaction(async (tx) => {
      const sub = await lockSubscription(vendorId, tx);
      if (!sub) throw new NotFoundError('Subscription');
      const updated = await updateSub(sub.id, enabled
        ? { autoRenewOptIn: true }
        // Opting out also forgets the stored card authorization.
        : { autoRenewOptIn: false, paystackAuthorizationCode: null, paystackCustomerEmail: null }, tx);
      await recordAudit({ actorUserId: userId, actorType: 'user', action: enabled ? 'subscription.auto_renew_on' : 'subscription.auto_renew_off', entityType: 'vendor_subscription', entityId: sub.id }, tx);
      return updated;
    });
  },

  /**
   * The invoice a vendor can pay now. Restricted subscriptions (cancelled, expired) get a
   * fresh invoice starting now ("resubscribe"). Locks the subscription row; call in a tx.
   */
  async payableInvoice(vendorId: string, tx: Db, now = new Date()): Promise<InvoiceRow> {
    const sub = await lockSubscription(vendorId, tx);
    if (!sub) throw new ConflictError('This vendor account is not enrolled in a subscription yet', 'SUBSCRIPTION_NOT_ENROLLED');
    const [open] = await openInvoices(sub.id, tx);
    if (open) return open;
    if (sub.status === 'cancelled' || sub.status === 'expired') {
      const inv = await issueInvoice(sub, now, tx);
      if (!inv) throw new ConflictError('Subscriptions are not available yet: no plan is configured', 'NO_ACTIVE_PLAN');
      return inv;
    }
    throw new ConflictError('No payment is due right now', 'NO_PAYMENT_DUE');
  },

  /**
   * Apply a verified, successful payment to its invoice. Idempotent. Must run inside the
   * transaction that marks the attempt succeeded. Returns false when the invoice was no
   * longer open (late or duplicate payment: recorded, flagged for review, no access change).
   */
  async applyInvoicePaid(invoiceId: string, attemptId: string, tx: Db, now = new Date()): Promise<boolean> {
    const [invoice] = await tx.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.id, invoiceId)).for('update');
    if (!invoice) throw new NotFoundError('Invoice');
    if (invoice.status !== 'open') return invoice.paidByAttemptId === attemptId;

    await tx.update(subscriptionInvoices).set({ status: 'paid', paidAt: now, paidByAttemptId: attemptId }).where(eq(subscriptionInvoices.id, invoiceId));
    const sub = await lockSubscription(invoice.vendorId, tx);
    if (!sub) throw new NotFoundError('Subscription');
    const updated = await updateSub(sub.id, {
      status: 'active', planId: invoice.planId,
      currentPeriodStart: invoice.periodStart, currentPeriodEnd: invoice.periodEnd,
      graceEndsAt: null, suspendedAt: null, expiredAt: null, cancelledAt: null, cancelAtPeriodEnd: false, billingHoldReason: null,
    }, tx);
    await recordAudit({ actorType: 'system', action: 'subscription.activated', entityType: 'vendor_subscription', entityId: sub.id, details: { from: sub.status, invoiceId, attemptId } }, tx);
    await enqueueOutbox(tx, 'subscription.payment_succeeded', { vendorId: sub.vendorId, invoiceId, attemptId, amountMinor: invoice.amountMinor, currency: invoice.currency, periodEnd: updated.currentPeriodEnd?.toISOString() }, { dedupeKey: `payment-succeeded:${attemptId}` });
    return true;
  },

  // ── Lifecycle (run by the scheduler; every step re-checks state under a row lock) ─
  async runLifecycle(now = new Date()): Promise<Record<string, number>> {
    const counts = { trialEnded: 0, renewed: 0, suspended: 0, expired: 0, cancelled: 0, reminders: 0, errors: 0 };
    const byVendor = (r: { vendorId: string }) => r.vendorId;

    const dueTrials = await db.select({ vendorId: vendorSubscriptions.vendorId }).from(vendorSubscriptions)
      .where(and(eq(vendorSubscriptions.status, 'trialing'), lte(vendorSubscriptions.trialEndsAt, now))).limit(500);
    counts.errors += (await eachIsolated(dueTrials, 'subscriptions.trial_end', byVendor, async ({ vendorId }) => {
      await withTransaction(async (tx) => {
        const sub = await lockSubscription(vendorId, tx);
        if (sub?.status !== 'trialing' || sub.trialEndsAt > now) return;
        if (sub.cancelAtPeriodEnd) {
          await updateSub(sub.id, { status: 'cancelled', cancelledAt: now }, tx);
          await recordAudit({ actorType: 'system', action: 'subscription.cancelled', entityType: 'vendor_subscription', entityId: sub.id, details: { at: 'trial_end' } }, tx);
          counts.cancelled++;
          return;
        }
        await billPeriod(sub, sub.trialEndsAt, tx);
        counts.trialEnded++;
      });
    })).failed;

    const dueRenewals = await db.select({ vendorId: vendorSubscriptions.vendorId }).from(vendorSubscriptions)
      .where(and(eq(vendorSubscriptions.status, 'active'), lte(vendorSubscriptions.currentPeriodEnd, now))).limit(500);
    counts.errors += (await eachIsolated(dueRenewals, 'subscriptions.renewal', byVendor, async ({ vendorId }) => {
      await withTransaction(async (tx) => {
        const sub = await lockSubscription(vendorId, tx);
        if (sub?.status !== 'active' || !sub.currentPeriodEnd || sub.currentPeriodEnd > now) return;
        if (sub.cancelAtPeriodEnd) {
          await updateSub(sub.id, { status: 'cancelled', cancelledAt: now }, tx);
          await recordAudit({ actorType: 'system', action: 'subscription.cancelled', entityType: 'vendor_subscription', entityId: sub.id, details: { at: 'period_end' } }, tx);
          counts.cancelled++;
          return;
        }
        await billPeriod(sub, sub.currentPeriodEnd, tx);
        counts.renewed++;
      });
    })).failed;

    // Subscriptions whose billing was held (no active plan) stay due and are billed by the
    // two queries above on the first tick after an admin activates a plan.

    const overdue = await db.select({ vendorId: vendorSubscriptions.vendorId }).from(vendorSubscriptions)
      .where(and(eq(vendorSubscriptions.status, 'past_due'), lte(vendorSubscriptions.graceEndsAt, now))).limit(500);
    counts.errors += (await eachIsolated(overdue, 'subscriptions.suspend', byVendor, async ({ vendorId }) => {
      await withTransaction(async (tx) => {
        const sub = await lockSubscription(vendorId, tx);
        if (sub?.status !== 'past_due' || !sub.graceEndsAt || sub.graceEndsAt > now) return;
        if ((await openInvoices(sub.id, tx)).length === 0) return; // paid concurrently
        await updateSub(sub.id, { status: 'suspended', suspendedAt: now }, tx);
        await recordAudit({ actorType: 'system', action: 'subscription.suspended', entityType: 'vendor_subscription', entityId: sub.id }, tx);
        await enqueueOutbox(tx, 'subscription.suspended', { vendorId: sub.vendorId }, { dedupeKey: `sub-suspended:${sub.id}:${sub.graceEndsAt.toISOString()}` });
        counts.suspended++;
      });
    })).failed;

    const expireBefore = addDays(now, -env.SUBSCRIPTION_EXPIRE_AFTER_SUSPENDED_DAYS);
    const stale = await db.select({ vendorId: vendorSubscriptions.vendorId }).from(vendorSubscriptions)
      .where(and(eq(vendorSubscriptions.status, 'suspended'), lte(vendorSubscriptions.suspendedAt, expireBefore))).limit(500);
    counts.errors += (await eachIsolated(stale, 'subscriptions.expire', byVendor, async ({ vendorId }) => {
      await withTransaction(async (tx) => {
        const sub = await lockSubscription(vendorId, tx);
        if (sub?.status !== 'suspended' || !sub.suspendedAt || sub.suspendedAt > expireBefore) return;
        for (const inv of await openInvoices(sub.id, tx)) {
          await tx.update(subscriptionInvoices).set({ status: 'void', voidedAt: now, voidReason: 'subscription_expired' }).where(eq(subscriptionInvoices.id, inv.id));
        }
        await updateSub(sub.id, { status: 'expired', expiredAt: now, graceEndsAt: null }, tx);
        await recordAudit({ actorType: 'system', action: 'subscription.expired', entityType: 'vendor_subscription', entityId: sub.id }, tx);
        await enqueueOutbox(tx, 'subscription.expired', { vendorId: sub.vendorId }, { dedupeKey: `sub-expired:${sub.id}:${sub.suspendedAt.toISOString()}` });
        counts.expired++;
      });
    })).failed;

    counts.reminders = await this.enqueueReminders(now);
    return counts;
  },

  /** Trial-ending and payment-due reminders. Each reminder is enqueued at most once (dedupe key). */
  async enqueueReminders(now: Date): Promise<number> {
    let sent = 0;
    const trialDays = [...env.SUBSCRIPTION_TRIAL_REMINDER_DAYS].sort((a, b) => a - b);
    const maxTrial = trialDays.at(-1) ?? 0;
    const trialing = await db.select().from(vendorSubscriptions)
      .where(and(eq(vendorSubscriptions.status, 'trialing'), eq(vendorSubscriptions.cancelAtPeriodEnd, false),
        lte(vendorSubscriptions.trialEndsAt, addDays(now, maxTrial)))).limit(1000);
    for (const sub of trialing) {
      if (sub.trialEndsAt <= now) continue;
      const daysLeft = (sub.trialEndsAt.getTime() - now.getTime()) / 86_400_000;
      // Only the nearest applicable reminder, so a delayed job never sends several at once.
      const d = trialDays.find((x) => daysLeft <= x);
      if (d === undefined) continue;
      if (await enqueueOutbox(db, 'subscription.trial_reminder', { vendorId: sub.vendorId, trialEndsAt: sub.trialEndsAt.toISOString(), daysLeft: Math.max(1, Math.ceil(daysLeft)) },
        { dedupeKey: `trial-reminder:${sub.id}:${sub.trialEndsAt.toISOString()}:${d}` })) sent++;
    }

    const payDays = [...env.SUBSCRIPTION_PAYMENT_REMINDER_DAYS].sort((a, b) => b - a);
    const pastDue = await db.select({ sub: vendorSubscriptions, inv: subscriptionInvoices })
      .from(vendorSubscriptions)
      .innerJoin(subscriptionInvoices, and(eq(subscriptionInvoices.subscriptionId, vendorSubscriptions.id), eq(subscriptionInvoices.status, 'open')))
      .where(inArray(vendorSubscriptions.status, ['past_due'])).limit(1000);
    for (const { sub, inv } of pastDue) {
      const daysSinceDue = (now.getTime() - inv.dueAt.getTime()) / 86_400_000;
      const d = payDays.find((x) => daysSinceDue >= x);
      if (d === undefined) continue;
      if (await enqueueOutbox(db, 'subscription.payment_due', {
        vendorId: sub.vendorId, invoiceId: inv.id, amountMinor: inv.amountMinor, currency: inv.currency,
        dueAt: inv.dueAt.toISOString(), graceEndsAt: sub.graceEndsAt?.toISOString() ?? null,
      }, { dedupeKey: `payment-due:${inv.id}:${d}` })) sent++;
    }
    return sent;
  },

  // ── Plans (admin) ──────────────────────────────────────────────────────────
  listPlans() {
    return db.query.subscriptionPlans.findMany({ orderBy: [desc(subscriptionPlans.createdAt)] });
  },

  /**
   * Create a plan (price) and optionally make it the one offered. Activating a new plan
   * deactivates the previous one; invoices already issued keep their amount, so a price
   * change applies from each vendor's next billing period.
   */
  async createPlan(input: { code: string; name: string; amountMinor: number; currency: 'KES'; activate: boolean }, adminUserId: string, requestId?: string) {
    if (input.currency === 'KES' && input.amountMinor % 100 !== 0) {
      throw new ValidationError('KES prices must be whole shillings (M-Pesa does not support cents)');
    }
    return withTransaction(async (tx) => {
      if (input.activate) {
        await tx.update(subscriptionPlans).set({ isActive: false, deactivatedAt: new Date() }).where(eq(subscriptionPlans.isActive, true));
      }
      const [plan] = await tx.insert(subscriptionPlans).values({
        code: input.code, name: input.name, amountMinor: input.amountMinor, currency: input.currency, isActive: input.activate, createdBy: adminUserId,
      }).returning();
      if (!plan) throw new Error('plan insert returned no row');
      await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: 'subscription_plan.created', entityType: 'subscription_plan', entityId: plan.id, details: { amountMinor: plan.amountMinor, currency: plan.currency, active: plan.isActive }, requestId }, tx);
      return plan;
    });
  },

  async setPlanActive(planId: string, active: boolean, adminUserId: string, requestId?: string) {
    return withTransaction(async (tx) => {
      const plan = await tx.query.subscriptionPlans.findFirst({ where: eq(subscriptionPlans.id, planId) });
      if (!plan) throw new NotFoundError('Plan');
      if (active) await tx.update(subscriptionPlans).set({ isActive: false, deactivatedAt: new Date() }).where(and(eq(subscriptionPlans.isActive, true)));
      const [row] = await tx.update(subscriptionPlans).set({ isActive: active, deactivatedAt: active ? null : new Date() }).where(eq(subscriptionPlans.id, planId)).returning();
      await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: active ? 'subscription_plan.activated' : 'subscription_plan.deactivated', entityType: 'subscription_plan', entityId: planId, requestId }, tx);
      return row;
    });
  },

  listForAdmin(filter: { status?: SubscriptionStatus | undefined; limit: number; offset: number }) {
    return db.select({
      id: vendorSubscriptions.id, vendorId: vendorSubscriptions.vendorId, businessName: vendors.businessName,
      status: vendorSubscriptions.status, trialEndsAt: vendorSubscriptions.trialEndsAt,
      currentPeriodEnd: vendorSubscriptions.currentPeriodEnd, graceEndsAt: vendorSubscriptions.graceEndsAt,
      billingHoldReason: vendorSubscriptions.billingHoldReason, origin: vendorSubscriptions.origin,
    }).from(vendorSubscriptions).innerJoin(vendors, eq(vendors.id, vendorSubscriptions.vendorId))
      .where(filter.status ? eq(vendorSubscriptions.status, filter.status) : undefined)
      .orderBy(desc(vendorSubscriptions.createdAt)).limit(filter.limit).offset(filter.offset);
  },

  /** Everything an administrator needs to investigate one vendor's billing. Read-only. */
  async getForAdmin(vendorId: string) {
    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId), columns: { id: true, businessName: true, status: true, createdAt: true } });
    if (!vendor) throw new NotFoundError('Vendor');
    const sub = await db.query.vendorSubscriptions.findFirst({ where: eq(vendorSubscriptions.vendorId, vendorId) });
    const [invoices, payments, audit] = await Promise.all([
      db.query.subscriptionInvoices.findMany({ where: eq(subscriptionInvoices.vendorId, vendorId), orderBy: [desc(subscriptionInvoices.periodStart)], limit: 24 }),
      db.query.paymentAttempts.findMany({
        where: eq(paymentAttempts.vendorId, vendorId), orderBy: [desc(paymentAttempts.createdAt)], limit: 50,
        columns: { checkoutUrl: false, providerMetadata: false },
      }),
      sub
        ? db.select().from(auditLog).where(and(eq(auditLog.entityType, 'vendor_subscription'), eq(auditLog.entityId, sub.id))).orderBy(desc(auditLog.createdAt)).limit(100)
        : Promise.resolve([]),
    ]);
    const entitlement = await this.getEntitlement(vendorId);
    return {
      vendor, entitlement,
      // The stored card authorization is a payment credential: never returned.
      subscription: sub ? { ...sub, paystackAuthorizationCode: undefined, hasSavedCard: sub.paystackAuthorizationCode != null } : null,
      invoices, payments, auditTrail: audit,
    };
  },

  /** Vendors with no subscription row: the population awaiting a transition-policy decision. */
  listUnenrolledVendors() {
    return db.select({ id: vendors.id, businessName: vendors.businessName, status: vendors.status, createdAt: vendors.createdAt })
      .from(vendors).leftJoin(vendorSubscriptions, eq(vendorSubscriptions.vendorId, vendors.id))
      .where(isNull(vendorSubscriptions.id)).orderBy(asc(vendors.createdAt));
  },
};
