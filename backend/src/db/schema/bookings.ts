import { pgTable, uuid, timestamp, integer, decimal, text, pgEnum } from 'drizzle-orm/pg-core';
import { listings } from './listings';
import { users } from './users';

export const bookingStatusEnum = pgEnum('booking_status', ['pending', 'confirmed', 'completed', 'cancelled', 'disputed']);

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => listings.id),
  customerId: uuid('customer_id').notNull().references(() => users.id),
  startDate: timestamp('start_date').notNull(),
  endDate: timestamp('end_date').notNull(),
  guests: integer('guests').notNull(),
  baseAmount: decimal('base_amount', { precision: 10, scale: 2 }).notNull(),
  platformFee: decimal('platform_fee', { precision: 10, scale: 2 }).notNull(),
  vat: decimal('vat', { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
  status: bookingStatusEnum('status').notNull().default('pending'),
  specialRequests: text('special_requests'),
  cancellationReason: text('cancellation_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});