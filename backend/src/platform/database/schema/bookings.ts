import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, timestamp, integer, decimal, text, pgEnum, index, varchar, customType, jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { listings } from './listings.js';
import { users } from './users.js';

/**
 * LEGACY (deprecated) status enum and column. It mixed payment semantics into bookings
 * ("confirmed" meant paid). Kept, nullable and no longer written, so existing rows are
 * preserved; removal is a separately reviewed contract migration.
 */
export const bookingStatusEnum = pgEnum('booking_status', [
  'pending', 'confirmed', 'completed', 'cancelled', 'declined', 'disputed',
]);

/**
 * Booking request lifecycle. No state implies that LinkMart handled payment: customers
 * and vendors settle directly.
 *   requested -> accepted | declined | expired | cancelled
 *   accepted  -> completed | cancelled
 */
export const bookingLifecycleStatusEnum = pgEnum('booking_lifecycle_status', [
  'requested', 'accepted', 'declined', 'expired', 'cancelled', 'completed',
]);

export const bookingActorEnum = pgEnum('booking_actor', ['customer', 'vendor', 'system', 'admin']);

const daterange = customType<{ data: string; driverData: string }>({
  dataType: () => 'daterange',
});

export const bookings = pgTable('bookings', {
  id:         uuid('id').primaryKey().defaultRandom(),
  listingId:  uuid('listing_id').notNull().references(() => listings.id),
  customerId: uuid('customer_id').notNull().references(() => users.id),

  // Calendar dates, inclusive on both ends, stored as midnight UTC.
  startDate: timestamp('start_date', { mode: 'date' }).notNull(),
  endDate:   timestamp('end_date',   { mode: 'date' }).notNull(),
  guests:    integer('guests').notNull(),

  // Reference snapshot of how the listing was priced at request time (informational only).
  pricingType: varchar('pricing_type', { length: 20 }).notNull(),
  currency:    varchar('currency', { length: 3 }).notNull().default('KES'),

  // LEGACY financial columns: never written by current code (LinkMart does not price,
  // charge or tax bookings). Nullable so new rows don't need them; drop in a contract migration.
  baseAmount:  decimal('base_amount',  { precision: 10, scale: 2 }),
  platformFee: decimal('platform_fee', { precision: 10, scale: 2 }),
  vat:         decimal('vat',          { precision: 10, scale: 2 }),
  totalAmount: decimal('total_amount', { precision: 10, scale: 2 }),

  legacyStatus: bookingStatusEnum('status'),
  status: bookingLifecycleStatusEnum('lifecycle_status').notNull().default('requested'),

  /** Inclusive date range used by the exclusion constraint on accepted bookings. */
  period: daterange('period').generatedAlwaysAs(sql`daterange((start_date)::date, (end_date)::date, '[]')`),

  /** Vendor response deadline. Enforced in the service layer; expiry job is a backstop. */
  respondBy: timestamp('respond_by', { withTimezone: true, mode: 'date' }),

  specialRequests:    text('special_requests'),
  cancellationReason: text('cancellation_reason'),
  declineReason:      text('decline_reason'),
  cancelledBy:        bookingActorEnum('cancelled_by'),

  respondedAt: timestamp('responded_at'),
  acceptedAt:  timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
  declinedAt:  timestamp('declined_at', { withTimezone: true, mode: 'date' }),
  expiredAt:   timestamp('expired_at',  { withTimezone: true, mode: 'date' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'date' }),
  completedAt: timestamp('completed_at'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  listingIdx:  index('bookings_listing_idx').on(table.listingId),
  customerIdx: index('bookings_customer_idx').on(table.customerId),
  statusIdx:   index('bookings_status_idx').on(table.legacyStatus),
  datesIdx:    index('bookings_dates_idx').on(table.startDate, table.endDate),
  listingLifecycleIdx:  index('bookings_listing_lifecycle_idx').on(table.listingId, table.status),
  customerLifecycleIdx: index('bookings_customer_lifecycle_idx').on(table.customerId, table.status),
  respondByIdx: index('bookings_requested_respond_by_idx').on(table.respondBy).where(sql`lifecycle_status = 'requested'`),
}));

/** Append-only audit trail of booking state transitions. */
export const bookingEvents = pgTable('booking_events', {
  id:        uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id').notNull().references(() => bookings.id),
  fromStatus: bookingLifecycleStatusEnum('from_status'),
  toStatus:   bookingLifecycleStatusEnum('to_status').notNull(),
  actor:      bookingActorEnum('actor').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  reason:     text('reason'),
  metadata:   jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt:  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  index('booking_events_booking_idx').on(t.bookingId, t.createdAt),
  index('booking_events_actor_idx').on(t.actorUserId),
]);

export const bookingsRelations = relations(bookings, ({ one }) => ({
  listing:  one(listings, { fields: [bookings.listingId],  references: [listings.id] }),
  customer: one(users,    { fields: [bookings.customerId], references: [users.id]    }),
}));
