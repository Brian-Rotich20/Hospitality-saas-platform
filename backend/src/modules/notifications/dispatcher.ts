// Outbox dispatcher (runs in the worker).
//
// Delivery protocol (at-least-once, no duplicate emails on retry):
//  1. Claim: in a short transaction, lock due rows with FOR UPDATE SKIP LOCKED, push their
//     `available_at` forward by a lease and count the attempt. Several workers can run
//     safely; a worker that dies mid-send releases its rows when the lease expires.
//  2. Send outside any transaction (no row locks held across network calls). After each
//     email, `delivered_count` is saved, so a retry resumes after the last sent email.
//  3. Settle: success sets `processed_at`. A failure backs off exponentially; after
//     MAX_ATTEMPTS (or a permanent error such as an unknown topic) the row is dead-lettered
//     with `failed_at` and waits for an administrator (GET/POST /api/admin/operations/outbox).
import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db, withTransaction } from '../../platform/database/client.js';
import { outbox } from '../../platform/database/schema/platform.js';
import { bookings } from '../../platform/database/schema/bookings.js';
import { listings } from '../../platform/database/schema/listings.js';
import { users } from '../../platform/database/schema/users.js';
import { vendors } from '../../platform/database/schema/vendors.js';
import { conversations } from '../../platform/database/schema/messaging.js';
import { mailer } from '../../platform/mailer/index.js';
import { templates, type Rendered } from '../../platform/mailer/templates.js';
import { formatMoney, toCalendarDate } from '../../platform/time.js';
import { logger } from '../../platform/logger.js';

export const OUTBOX_MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
type OutboxRow = typeof outbox.$inferSelect;
type Mail = { to: string; rendered: Rendered };

/** A delivery that can never succeed by retrying (dead-lettered immediately). */
export class PermanentDeliveryError extends Error {}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

async function bookingContext(bookingId: string) {
  const [row] = await db.select({
    b: bookings, title: listings.title, customerEmail: users.email, customerName: users.fullName, vendorUserId: vendors.userId, businessName: vendors.businessName,
  }).from(bookings)
    .innerJoin(listings, eq(listings.id, bookings.listingId))
    .innerJoin(vendors, eq(vendors.id, listings.vendorId))
    .innerJoin(users, eq(users.id, bookings.customerId))
    .where(eq(bookings.id, bookingId));
  if (!row) return null;
  const vendorUser = await db.query.users.findFirst({ where: eq(users.id, row.vendorUserId), columns: { email: true } });
  return { ...row, vendorEmail: vendorUser?.email ?? null, dates: `${toCalendarDate(row.b.startDate)} → ${toCalendarDate(row.b.endDate)}` };
}

async function vendorContact(vendorId: string) {
  const [row] = await db.select({ email: users.email, businessName: vendors.businessName }).from(vendors).innerJoin(users, eq(users.id, vendors.userId)).where(eq(vendors.id, vendorId));
  return row ?? null;
}

/**
 * The emails to send for a row, in a stable order (delivered_count indexes into it).
 * [] means there is nothing to send (e.g. the entity no longer exists).
 */
async function render(row: OutboxRow): Promise<Mail[]> {
  const p = row.payload;
  switch (row.topic) {
    case 'booking.requested': {
      const c = await bookingContext(str(p.bookingId));
      if (!c?.vendorEmail) return [];
      return [{ to: c.vendorEmail, rendered: templates.bookingRequested(c.businessName, c.title, c.dates, c.b.id, c.b.respondBy?.toISOString() ?? '') }];
    }
    case 'booking.accepted': {
      const c = await bookingContext(str(p.bookingId));
      return c ? [{ to: c.customerEmail, rendered: templates.bookingAccepted(c.customerName ?? 'there', c.title, c.dates, c.b.id) }] : [];
    }
    case 'booking.declined': {
      const c = await bookingContext(str(p.bookingId));
      return c ? [{ to: c.customerEmail, rendered: templates.bookingDeclined(c.customerName ?? 'there', c.title, c.b.declineReason ?? '') }] : [];
    }
    case 'booking.expired': {
      const c = await bookingContext(str(p.bookingId));
      if (!c) return [];
      const out: Mail[] = [{ to: c.customerEmail, rendered: templates.bookingExpired(c.customerName ?? 'there', c.title, false) }];
      if (c.vendorEmail) out.push({ to: c.vendorEmail, rendered: templates.bookingExpired(c.businessName, c.title, true) });
      return out;
    }
    case 'booking.cancelled': {
      const c = await bookingContext(str(p.bookingId));
      if (!c) return [];
      const byCustomer = str(p.cancelledBy) === 'customer';
      const to = byCustomer ? c.vendorEmail : c.customerEmail;
      if (!to) return [];
      return [{ to, rendered: templates.bookingCancelled(byCustomer ? c.businessName : (c.customerName ?? 'there'), c.title, byCustomer ? 'customer' : 'vendor', c.b.cancellationReason ?? '') }];
    }
    case 'message.created': {
      const conv = await db.query.conversations.findFirst({ where: eq(conversations.id, str(p.conversationId)) });
      if (!conv) return [];
      const c = await bookingContext(conv.bookingId);
      if (!c) return [];
      return str(p.recipient) === 'vendor'
        ? (c.vendorEmail ? [{ to: c.vendorEmail, rendered: templates.newMessage(c.businessName, c.title, conv.id) }] : [])
        : [{ to: c.customerEmail, rendered: templates.newMessage(c.customerName ?? 'there', c.title, conv.id) }];
    }
    case 'subscription.trial_reminder': {
      const v = await vendorContact(str(p.vendorId));
      return v ? [{ to: v.email, rendered: templates.trialEnding(v.businessName, str(p.trialEndsAt), Number(p.daysLeft ?? 1)) }] : [];
    }
    case 'subscription.payment_due': {
      const v = await vendorContact(str(p.vendorId));
      return v ? [{ to: v.email, rendered: templates.paymentDue(v.businessName, formatMoney(Number(p.amountMinor), str(p.currency)), str(p.dueAt), str(p.graceEndsAt)) }] : [];
    }
    case 'subscription.payment_succeeded': {
      const v = await vendorContact(str(p.vendorId));
      return v ? [{ to: v.email, rendered: templates.paymentSucceeded(v.businessName, formatMoney(Number(p.amountMinor), str(p.currency)), str(p.periodEnd), str(p.attemptId)) }] : [];
    }
    case 'subscription.payment_failed': {
      const v = await vendorContact(str(p.vendorId));
      return v ? [{ to: v.email, rendered: templates.paymentFailed(v.businessName, formatMoney(Number(p.amountMinor), str(p.currency)), str(p.reason)) }] : [];
    }
    case 'subscription.suspended': {
      const v = await vendorContact(str(p.vendorId));
      return v ? [{ to: v.email, rendered: templates.subscriptionSuspended(v.businessName) }] : [];
    }
    case 'subscription.expired': {
      const v = await vendorContact(str(p.vendorId));
      return v ? [{ to: v.email, rendered: templates.subscriptionExpired(v.businessName) }] : [];
    }
    default:
      throw new PermanentDeliveryError(`unknown outbox topic: ${row.topic}`);
  }
}

async function claim(batch: number): Promise<OutboxRow[]> {
  return withTransaction(async (tx) => {
    const now = new Date();
    const rows = await tx.select().from(outbox)
      .where(and(isNull(outbox.processedAt), isNull(outbox.failedAt), lte(outbox.availableAt, now)))
      .orderBy(asc(outbox.availableAt)).limit(batch).for('update', { skipLocked: true });
    if (rows.length === 0) return [];
    await tx.update(outbox)
      .set({ availableAt: new Date(now.getTime() + LEASE_MS), attempts: sql`${outbox.attempts} + 1` })
      .where(inArray(outbox.id, rows.map((r) => r.id)));
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
}

async function deliver(row: OutboxRow): Promise<'delivered' | 'retry' | 'dead'> {
  let delivered = row.deliveredCount;
  try {
    const mails = await render(row);
    for (let i = delivered; i < mails.length; i++) {
      const m = mails[i];
      if (!m) break;
      await mailer.send({ to: m.to, subject: m.rendered.subject, html: m.rendered.html, tag: row.topic });
      delivered = i + 1;
      await db.update(outbox).set({ deliveredCount: delivered }).where(eq(outbox.id, row.id));
    }
    await db.update(outbox).set({ processedAt: new Date(), lastError: null, deliveredCount: delivered }).where(eq(outbox.id, row.id));
    return 'delivered';
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    const dead = err instanceof PermanentDeliveryError || row.attempts >= OUTBOX_MAX_ATTEMPTS;
    const delayMs = Math.min(60 * 60_000, 30_000 * 2 ** row.attempts);
    await db.update(outbox).set({
      lastError: message, deliveredCount: delivered,
      availableAt: new Date(Date.now() + delayMs), failedAt: dead ? new Date() : null,
    }).where(eq(outbox.id, row.id));
    // No recipient addresses in logs: the row id and topic identify the notification.
    if (dead) logger.error({ id: row.id, topic: row.topic, attempts: row.attempts, err: message }, 'outbox notification dead-lettered; needs operator attention');
    else logger.warn({ id: row.id, topic: row.topic, attempts: row.attempts, err: message }, 'outbox delivery failed; will retry');
    return dead ? 'dead' : 'retry';
  }
}

/** Claim and deliver up to `batch` due outbox rows. Returns how many were claimed. */
export async function dispatchOutbox(batch = 25): Promise<number> {
  const rows = await claim(batch);
  for (const row of rows) await deliver(row);
  return rows.length;
}
