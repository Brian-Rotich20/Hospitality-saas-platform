// Availability = vendor-blocked dates + accepted bookings. Booking *requests* do not hold
// dates (decision D10 default): only acceptance reserves, and acceptance is protected by a
// database exclusion constraint plus a per-listing row lock.
import { and, between, eq, inArray, sql } from 'drizzle-orm';
import { db, withTransaction, type Db } from '../../platform/database/client.js';
import { availability } from '../../platform/database/schema/availability.js';
import { bookings } from '../../platform/database/schema/bookings.js';
import { listings } from '../../platform/database/schema/listings.js';
import { listingsService } from '../catalog/listings.service.js';
import { addDays, parseCalendarDate, toCalendarDate } from '../../platform/time.js';
import { ConflictError, NotFoundError, ValidationError } from '../../app/errors.js';

const MAX_RANGE_DAYS = 366;

export function safeDate(value: string): Date {
  try {
    return parseCalendarDate(value);
  } catch {
    throw new ValidationError(`Invalid date: ${value}`);
  }
}

function validateRange(start: string, end: string) {
  const s = safeDate(start);
  const e = safeDate(end);
  if (e < s) throw new ValidationError('End date must be on or after start date');
  if ((e.getTime() - s.getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw new ValidationError(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  return { s, e };
}

function eachDate(start: Date, end: Date): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(toCalendarDate(d));
  return out;
}

/** Dates in [start, end] occupied by accepted bookings or vendor blocks. */
export async function unavailableDates(listingId: string, start: string, end: string, tx: Db = db) {
  const blocked = await tx.select({ date: availability.date, reason: availability.blockedReason }).from(availability)
    .where(and(eq(availability.listingId, listingId), eq(availability.available, false), between(availability.date, start, end)));
  const accepted = await tx.select({ id: bookings.id, startDate: bookings.startDate, endDate: bookings.endDate }).from(bookings)
    .where(and(eq(bookings.listingId, listingId), eq(bookings.status, 'accepted'),
      sql`${bookings.period} && daterange(${start}::date, ${end}::date, '[]')`));
  return { blocked, accepted };
}

export const availabilityService = {
  async isAvailable(listingId: string, start: string, end: string, tx: Db = db): Promise<boolean> {
    validateRange(start, end);
    const { blocked, accepted } = await unavailableDates(listingId, start, end, tx);
    return blocked.length === 0 && accepted.length === 0;
  },

  async calendar(listingId: string, start: string, end: string) {
    const { s, e } = validateRange(start, end);
    const exists = await db.query.listings.findFirst({ where: and(eq(listings.id, listingId), sql`${listings.status} <> 'deleted'`), columns: { id: true } });
    if (!exists) throw new NotFoundError('Listing');
    const { blocked, accepted } = await unavailableDates(listingId, start, end);
    const days: Record<string, { available: boolean; reason?: string }> = {};
    for (const b of blocked) days[b.date] = { available: false, reason: 'Unavailable' }; // vendor's private reason is not exposed
    for (const a of accepted) {
      const from = a.startDate < s ? s : a.startDate;
      const to = a.endDate > e ? e : a.endDate;
      for (const d of eachDate(from, to)) days[d] = { available: false, reason: 'Booked' };
    }
    return days;
  },

  async block(listingId: string, vendorId: string, dates: string[], reason: string | undefined) {
    const unique = [...new Set(dates)].sort();
    unique.forEach((d) => safeDate(d));
    return withTransaction(async (tx) => {
      await listingsService.lockOwned(listingId, vendorId, tx);
      const first = unique[0]!;
      const last = unique[unique.length - 1]!;
      const { accepted } = await unavailableDates(listingId, first, last, tx);
      const clash = unique.filter((d) => accepted.some((a) => d >= toCalendarDate(a.startDate) && d <= toCalendarDate(a.endDate)));
      if (clash.length) throw new ConflictError('Some dates have accepted bookings. Cancel those bookings first.', 'DATES_BOOKED', { dates: clash });
      const rows = await tx.insert(availability)
        .values(unique.map((date) => ({ listingId, date, available: false, blockedReason: reason ?? null })))
        .onConflictDoUpdate({ target: [availability.listingId, availability.date], set: { available: false, blockedReason: reason ?? null, updatedAt: new Date() } })
        .returning({ date: availability.date });
      return rows.map((r) => r.date);
    });
  },

  async unblock(listingId: string, vendorId: string, dates: string[]) {
    const unique = [...new Set(dates)];
    unique.forEach((d) => safeDate(d));
    return withTransaction(async (tx) => {
      await listingsService.lockOwned(listingId, vendorId, tx);
      const rows = await tx.update(availability).set({ available: true, blockedReason: null, updatedAt: new Date() })
        .where(and(eq(availability.listingId, listingId), inArray(availability.date, unique), eq(availability.available, false)))
        .returning({ date: availability.date });
      return rows.map((r) => r.date);
    });
  },
};
