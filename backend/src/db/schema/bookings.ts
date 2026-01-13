import { pgTable, uuid, timestamp, integer, decimal, text, pgEnum, varchar, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { listings } from './listings';
import { users } from './users';

export const bookingStatusEnum = pgEnum('booking_status', [
  'pending',
  'confirmed', 
  'completed',
  'cancelled',
  'declined',
  'disputed'
]);

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => listings.id),
  customerId: uuid('customer_id').notNull().references(() => users.id),
  
  // Booking dates
  startDate: timestamp('start_date', { mode: 'date' }).notNull(),
  endDate: timestamp('end_date', { mode: 'date' }).notNull(),
  guests: integer('guests').notNull(),
  
  // Pricing breakdown
  baseAmount: decimal('base_amount', { precision: 10, scale: 2 }).notNull(),
  platformFee: decimal('platform_fee', { precision: 10, scale: 2 }).notNull(),
  vat: decimal('vat', { precision: 10, scale: 2 }).notNull(),
  totalAmount: decimal('total_amount', { precision: 10, scale: 2 }).notNull(),
  
  // Status and notes
  status: bookingStatusEnum('status').notNull().default('pending'),
  specialRequests: text('special_requests'),
  cancellationReason: text('cancellation_reason'),
  declineReason: text('decline_reason'),
  
  // Response tracking
  respondedAt: timestamp('responded_at'),
  completedAt: timestamp('completed_at'),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => {
  return {
    listingIdx: index('bookings_listing_idx').on(table.listingId),
    customerIdx: index('bookings_customer_idx').on(table.customerId),
    statusIdx: index('bookings_status_idx').on(table.status),
    datesIdx: index('bookings_dates_idx').on(table.startDate, table.endDate),
  };
});

export const bookingsRelations = relations(bookings, ({ one }) => ({
  listing: one(listings, {
    fields: [bookings.listingId],
    references: [listings.id],
  }),
  customer: one(users, {
    fields: [bookings.customerId],
    references: [users.id],
  }),
}));