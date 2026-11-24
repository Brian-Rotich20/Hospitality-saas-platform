// Booking requests. LinkMart records the request and the vendor's response; payment for
// the service is arranged directly between customer and vendor, outside the platform.
//
//   requested --vendor accepts (before respond_by)--> accepted --after end date--> completed
//   requested --vendor declines--> declined
//   requested --respond_by passes--> expired      (service-enforced + BullMQ + sweeper)
//   requested|accepted --customer/vendor cancels before start--> cancelled
import { and, asc, desc, eq, gt, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import { db, withTransaction, type Db } from '../../platform/database/client.js';
import { bookings, bookingEvents } from '../../platform/database/schema/bookings.js';
import { listings } from '../../platform/database/schema/listings.js';
import { users } from '../../platform/database/schema/users.js';
import { vendors } from '../../platform/database/schema/vendors.js';
import { env } from '../../platform/config/env.js';
import { addDays, addHours, parseCalendarDate, toCalendarDate, todayInNairobi } from '../../platform/time.js';
import { scheduleBookingExpiry } from '../../platform/queue/index.js';
import { eachIsolated } from '../../platform/batch.js';
import { listingsService } from '../catalog/listings.service.js';
import { unavailableDates, safeDate } from '../availability/service.js';
import { subscriptionsService } from '../subscriptions/service.js';
import { messagingService } from '../messaging/service.js';
import { enqueueOutbox } from '../notifications/outbox.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../app/errors.js';
import type { AuthContext } from '../../app/policies.js';

export type BookingRow = typeof bookings.$inferSelect;
export type BookingStatus = BookingRow['status'];
type Actor = 'customer' | 'vendor' | 'system' | 'admin';

const MAX_STAY_DAYS = 366;

async function lockBooking(id: string, tx: Db) {
  const [row] = await tx.select().from(bookings).where(eq(bookings.id, id)).for('update');
  return row;
}

async function transition(tx: Db, b: BookingRow, to: BookingStatus, actor: Actor, actorUserId: string | null, values: Partial<typeof bookings.$inferInsert>, reason?: string) {
  const now = new Date();
  const [row] = await tx.update(bookings).set({ ...values, status: to, updatedAt: now }).where(eq(bookings.id, b.id)).returning();
  await tx.insert(bookingEvents).values({ bookingId: b.id, fromStatus: b.status, toStatus: to, actor, actorUserId, reason: reason ?? null });
  if (!row) throw new Error('booking update returned no row');
  return row;
}

async function vendorOwnsBooking(b: BookingRow, vendorId: string, tx: Db) {
  const l = await tx.query.listings.findFirst({ where: eq(listings.id, b.listingId), columns: { vendorId: true } });
  return l?.vendorId === vendorId;
}

/** Expire `b` if its deadline passed. Returns the expired row, or null if still open. */
async function expireIfOverdue(tx: Db, b: BookingRow, now: Date) {
  if (b.status !== 'requested' || !b.respondBy || b.respondBy > now) return null;
  const row = await transition(tx, b, 'expired', 'system', null, { expiredAt: now }, 'No vendor response within the response window');
  await enqueueOutbox(tx, 'booking.expired', { bookingId: b.id }, { dedupeKey: `booking-expired:${b.id}` });
  return row;
}

function datesOf(b: BookingRow) {
  return { startDate: toCalendarDate(b.startDate), endDate: toCalendarDate(b.endDate) };
}

export const bookingsService = {
  /** Customer submits a request. No payment is involved at any point. */
  async request(customer: AuthContext, input: { listingId: string; startDate: string; endDate: string; guests: number; specialRequests?: string | undefined }) {
    // Service-level re-check of the policy layer: only customer accounts may book.
    if (customer.role !== 'customer') throw new ForbiddenError('Only customer accounts can submit booking requests', 'CUSTOMERS_ONLY');
    const start = safeDate(input.startDate);
    const end = safeDate(input.endDate);
    if (end < start) throw new ValidationError('End date must be on or after start date');
    if (input.startDate < todayInNairobi()) throw new ValidationError('Start date cannot be in the past');
    if ((end.getTime() - start.getTime()) / 86_400_000 >= MAX_STAY_DAYS) throw new ValidationError(`A booking cannot exceed ${MAX_STAY_DAYS} days`);

    const created = await withTransaction(async (tx) => {
      const listing = await listingsService.lockBookable(input.listingId, tx);
      if (listing.vendorUserId === customer.userId) throw new ForbiddenError('You cannot book your own listing', 'OWN_LISTING');

      const [{ open } = { open: 0 }] = await tx.select({ open: sql<number>`count(*)::int` }).from(bookings)
        .where(and(eq(bookings.customerId, customer.userId), eq(bookings.status, 'requested')));
      if (open >= env.BOOKING_MAX_OPEN_REQUESTS_PER_CUSTOMER) {
        throw new ConflictError(`You can have at most ${env.BOOKING_MAX_OPEN_REQUESTS_PER_CUSTOMER} open requests. Wait for vendors to respond or cancel one.`, 'TOO_MANY_OPEN_REQUESTS');
      }
      const dup = await tx.select({ id: bookings.id }).from(bookings).where(and(
        eq(bookings.customerId, customer.userId), eq(bookings.listingId, input.listingId), eq(bookings.status, 'requested'),
        sql`${bookings.period} && daterange(${input.startDate}::date, ${input.endDate}::date, '[]')`)).limit(1);
      if (dup.length) throw new ConflictError('You already have an open request for these dates', 'DUPLICATE_REQUEST');

      const { blocked, accepted } = await unavailableDates(input.listingId, input.startDate, input.endDate, tx);
      if (blocked.length || accepted.length) throw new ConflictError('Selected dates are not available', 'DATES_UNAVAILABLE');

      const now = new Date();
      const [row] = await tx.insert(bookings).values({
        listingId: input.listingId, customerId: customer.userId, startDate: start, endDate: end, guests: input.guests,
        pricingType: listing.pricingType, currency: listing.currency, specialRequests: input.specialRequests ?? null,
        status: 'requested', legacyStatus: null, respondBy: addHours(now, env.BOOKING_RESPONSE_HOURS),
      }).returning();
      if (!row) throw new Error('booking insert returned no row');
      await tx.insert(bookingEvents).values({ bookingId: row.id, fromStatus: null, toStatus: 'requested', actor: 'customer', actorUserId: customer.userId });
      await enqueueOutbox(tx, 'booking.requested', { bookingId: row.id }, { dedupeKey: `booking-requested:${row.id}` });
      return row;
    });
    if (created.respondBy) await scheduleBookingExpiry(created.id, created.respondBy);
    return created;
  },

  async accept(bookingId: string, vendorId: string, userId: string) {
    let expired = false;
    try {
      const result = await withTransaction(async (tx) => {
        const b = await lockBooking(bookingId, tx);
        if (!b || !(await vendorOwnsBooking(b, vendorId, tx))) throw new NotFoundError('Booking');
        if (await expireIfOverdue(tx, b, new Date())) { expired = true; return null; }
        if (b.status !== 'requested') throw new ConflictError(`Cannot accept a ${b.status} request`, 'INVALID_TRANSITION');

        // Re-check vendor moderation + subscription inside the transaction.
        const v = await tx.query.vendors.findFirst({ where: eq(vendors.id, vendorId), columns: { status: true } });
        if (v?.status !== 'approved') throw new ForbiddenError('Your vendor account is suspended', 'VENDOR_SUSPENDED');
        if (!(await subscriptionsService.getEntitlement(vendorId, tx)).entitled) {
          throw new ForbiddenError('Your subscription is not active. Pay the outstanding invoice to accept requests.', 'SUBSCRIPTION_INACTIVE');
        }

        await listingsService.lockOwned(b.listingId, vendorId, tx);
        const { startDate, endDate } = datesOf(b);
        const { blocked, accepted } = await unavailableDates(b.listingId, startDate, endDate, tx);
        if (blocked.length || accepted.length) throw new ConflictError('These dates are no longer available', 'DATES_UNAVAILABLE');

        const now = new Date();
        const row = await transition(tx, b, 'accepted', 'vendor', userId, { acceptedAt: now, respondedAt: now });

        // Overlapping open requests can no longer be honoured: decline them now.
        const overlapping = await tx.select().from(bookings).where(and(
          eq(bookings.listingId, b.listingId), eq(bookings.status, 'requested'), ne(bookings.id, b.id),
          sql`${bookings.period} && daterange(${startDate}::date, ${endDate}::date, '[]')`)).for('update');
        for (const o of overlapping) {
          await transition(tx, o, 'declined', 'system', null, { declineReason: 'Dates no longer available', declinedAt: now, respondedAt: now }, 'Overlapping request accepted');
          await enqueueOutbox(tx, 'booking.declined', { bookingId: o.id }, { dedupeKey: `booking-declined:${o.id}` });
        }

        await messagingService.openForBooking(tx, row, vendorId);
        await enqueueOutbox(tx, 'booking.accepted', { bookingId: b.id }, { dedupeKey: `booking-accepted:${b.id}` });
        return row;
      });
      if (expired) throw new ConflictError('This request has expired and can no longer be accepted', 'REQUEST_EXPIRED');
      return result;
    } catch (err) {
      // The exclusion constraint is the last line of defence against double booking.
      if ((err as { cause?: { code?: string } }).cause?.code === '23P01' || (err as { code?: string }).code === '23P01') {
        throw new ConflictError('These dates are no longer available', 'DATES_UNAVAILABLE');
      }
      throw err;
    }
  },

  async decline(bookingId: string, vendorId: string, userId: string, reason: string) {
    let expired = false;
    const result = await withTransaction(async (tx) => {
      const b = await lockBooking(bookingId, tx);
      if (!b || !(await vendorOwnsBooking(b, vendorId, tx))) throw new NotFoundError('Booking');
      if (await expireIfOverdue(tx, b, new Date())) { expired = true; return null; }
      if (b.status !== 'requested') throw new ConflictError(`Cannot decline a ${b.status} request`, 'INVALID_TRANSITION');
      const now = new Date();
      const row = await transition(tx, b, 'declined', 'vendor', userId, { declineReason: reason, declinedAt: now, respondedAt: now }, reason);
      await enqueueOutbox(tx, 'booking.declined', { bookingId: b.id }, { dedupeKey: `booking-declined:${b.id}` });
      return row;
    });
    if (expired) throw new ConflictError('This request has already expired', 'REQUEST_EXPIRED');
    return result;
  },

  /** Customer (requested/accepted) or vendor (accepted) cancels before the start date. */
  async cancel(bookingId: string, actor: AuthContext, vendorId: string | null, reason: string) {
    return withTransaction(async (tx) => {
      const b = await lockBooking(bookingId, tx);
      if (!b) throw new NotFoundError('Booking');
      const asCustomer = b.customerId === actor.userId;
      const asVendor = !asCustomer && vendorId !== null && (await vendorOwnsBooking(b, vendorId, tx));
      if (!asCustomer && !asVendor) throw new NotFoundError('Booking');

      const allowed: BookingStatus[] = asCustomer ? ['requested', 'accepted'] : ['accepted'];
      if (!allowed.includes(b.status)) throw new ConflictError(`Cannot cancel a ${b.status} booking`, 'INVALID_TRANSITION');
      if (toCalendarDate(b.startDate) <= todayInNairobi()) throw new ConflictError('Bookings cannot be cancelled on or after the start date', 'BOOKING_STARTED');

      const by = asCustomer ? 'customer' : 'vendor';
      const row = await transition(tx, b, 'cancelled', by, actor.userId, { cancelledBy: by, cancellationReason: reason, cancelledAt: new Date() }, reason);
      await enqueueOutbox(tx, 'booking.cancelled', { bookingId: b.id, cancelledBy: by }, { dedupeKey: `booking-cancelled:${b.id}` });
      return row;
    });
  },

  // ── Background transitions ─────────────────────────────────────────────────
  /** Expire one request if overdue. Idempotent; safe for duplicate job delivery. */
  async expire(bookingId: string, now = new Date()): Promise<boolean> {
    return withTransaction(async (tx) => {
      const b = await lockBooking(bookingId, tx);
      if (!b) return false;
      return (await expireIfOverdue(tx, b, now)) !== null;
    });
  },

  /** Backstop for lost or delayed queue jobs. */
  async expireOverdue(now = new Date()): Promise<number> {
    const due = await db.select({ id: bookings.id }).from(bookings)
      .where(and(eq(bookings.status, 'requested'), lte(bookings.respondBy, now))).orderBy(asc(bookings.respondBy)).limit(500);
    let n = 0;
    await eachIsolated(due, 'bookings.expire_overdue', (r) => r.id, async ({ id }) => { if (await this.expire(id, now)) n++; });
    return n;
  },

  /** Mark accepted bookings completed N days after their end date (enables reviews). */
  async autoComplete(now = new Date()): Promise<number> {
    const cutoff = parseCalendarDate(toCalendarDate(addDays(now, -env.BOOKING_AUTO_COMPLETE_DAYS)));
    const due = await db.select({ id: bookings.id }).from(bookings)
      .where(and(eq(bookings.status, 'accepted'), lt(bookings.endDate, cutoff))).limit(500);
    let n = 0;
    await eachIsolated(due, 'bookings.auto_complete', (r) => r.id, async ({ id }) => {
      await withTransaction(async (tx) => {
        const b = await lockBooking(id, tx);
        if (b?.status !== 'accepted' || b.endDate >= cutoff) return;
        await transition(tx, b, 'completed', 'system', null, { completedAt: now });
        await tx.update(listings).set({ bookingsCount: sql`${listings.bookingsCount} + 1` }).where(eq(listings.id, b.listingId));
        n++;
      });
    });
    return n;
  },

  // ── Reads ──────────────────────────────────────────────────────────────────
  async getForParty(bookingId: string, actor: AuthContext, vendorId: string | null) {
    const b = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId) });
    if (!b) throw new NotFoundError('Booking');
    const listing = await db.query.listings.findFirst({ where: eq(listings.id, b.listingId), columns: { id: true, title: true, slug: true, coverPhoto: true, location: true, vendorId: true } });
    const isCustomer = b.customerId === actor.userId;
    const isVendor = vendorId !== null && listing?.vendorId === vendorId;
    if (!isCustomer && !isVendor && actor.role !== 'admin') throw new NotFoundError('Booking');
    return present(b, listing, await partyDetails(b, listing?.vendorId, isVendor || actor.role === 'admin'));
  },

  async listForCustomer(customerId: string, f: { status?: BookingStatus | undefined; limit: number; offset: number }) {
    const conds: SQL[] = [eq(bookings.customerId, customerId)];
    if (f.status) conds.push(eq(bookings.status, f.status));
    return listWith(and(...conds), f, false);
  },

  async listForVendor(vendorId: string, f: { status?: BookingStatus | undefined; limit: number; offset: number }) {
    const conds: SQL[] = [eq(listings.vendorId, vendorId)];
    if (f.status) conds.push(eq(bookings.status, f.status));
    return listWith(and(...conds), f, true);
  },

  async listForAdmin(f: { status?: BookingStatus | undefined; limit: number; offset: number }) {
    return listWith(f.status ? eq(bookings.status, f.status) : undefined, f, true);
  },

  async events(bookingId: string) {
    return db.query.bookingEvents.findMany({ where: eq(bookingEvents.bookingId, bookingId), orderBy: [asc(bookingEvents.createdAt)] });
  },

  /** Requests still awaiting this vendor's answer, soonest deadline first. */
  async pendingForVendor(vendorId: string) {
    return listWith(and(eq(listings.vendorId, vendorId), eq(bookings.status, 'requested'), gt(bookings.respondBy, new Date())), { limit: 100, offset: 0 }, true, 'deadline');
  },
};

async function partyDetails(b: BookingRow, vendorId: string | undefined, viewerIsVendorSide: boolean) {
  const shareContacts = b.status === 'accepted' || b.status === 'completed';
  const customer = await db.query.users.findFirst({ where: eq(users.id, b.customerId), columns: { id: true, fullName: true, email: true, phone: true } });
  const vendor = vendorId ? await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId), columns: { id: true, businessName: true, slug: true, logo: true, phoneNumber: true } }) : undefined;
  return {
    // Contact details are exchanged only once the vendor has accepted.
    customer: customer ? { id: customer.id, fullName: customer.fullName, ...(viewerIsVendorSide && shareContacts ? { email: customer.email, phone: customer.phone } : {}) } : null,
    vendor: vendor ? { id: vendor.id, businessName: vendor.businessName, slug: vendor.slug, logo: vendor.logo, ...(shareContacts ? { phoneNumber: vendor.phoneNumber } : {}) } : null,
  };
}

function present(b: BookingRow, listing: { id: string; title: string; slug: string; coverPhoto: string | null; location: unknown } | undefined, parties: { customer: unknown; vendor: unknown }) {
  return {
    id: b.id, status: b.status, ...datesOf(b), guests: b.guests, specialRequests: b.specialRequests,
    pricingType: b.pricingType, currency: b.currency,
    respondBy: b.status === 'requested' ? b.respondBy : null,
    declineReason: b.declineReason, cancellationReason: b.cancellationReason, cancelledBy: b.cancelledBy,
    acceptedAt: b.acceptedAt, declinedAt: b.declinedAt, expiredAt: b.expiredAt, cancelledAt: b.cancelledAt, completedAt: b.completedAt,
    createdAt: b.createdAt,
    listing: listing ? { id: listing.id, title: listing.title, slug: listing.slug, coverPhoto: listing.coverPhoto, location: listing.location } : null,
    ...parties,
    paymentNote: 'Payment for this service is arranged directly between the customer and the vendor. LinkMart does not process it.',
  };
}

async function listWith(where: SQL | undefined, f: { limit: number; offset: number }, vendorSide: boolean, order: 'recent' | 'deadline' = 'recent') {
  const rows = await db.select({
    b: bookings,
    listing: { id: listings.id, title: listings.title, coverPhoto: listings.coverPhoto, slug: listings.slug },
    customer: { id: users.id, fullName: users.fullName, email: users.email, phone: users.phone },
    vendor: { id: vendors.id, businessName: vendors.businessName, phoneNumber: vendors.phoneNumber },
  }).from(bookings)
    .innerJoin(listings, eq(listings.id, bookings.listingId))
    .innerJoin(vendors, eq(vendors.id, listings.vendorId))
    .innerJoin(users, eq(users.id, bookings.customerId))
    .where(where)
    .orderBy(order === 'deadline' ? asc(bookings.respondBy) : desc(bookings.createdAt))
    .limit(f.limit).offset(f.offset);
  return rows.map(({ b, listing, customer, vendor }) => {
    const share = b.status === 'accepted' || b.status === 'completed';
    return {
      id: b.id, status: b.status, ...datesOf(b), guests: b.guests, respondBy: b.status === 'requested' ? b.respondBy : null,
      createdAt: b.createdAt, listing,
      ...(vendorSide
        ? { customer: { id: customer.id, fullName: customer.fullName, ...(share ? { email: customer.email, phone: customer.phone } : {}) } }
        : { vendor: { id: vendor.id, businessName: vendor.businessName, ...(share ? { phoneNumber: vendor.phoneNumber } : {}) } }),
    };
  });
}

export const LEGACY_STATUS_ALIASES: Record<string, BookingStatus> = { pending: 'requested', confirmed: 'accepted' };
