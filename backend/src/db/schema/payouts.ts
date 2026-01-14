import { pgTable, uuid, decimal, varchar, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { vendors, bookings } from './index';

export const payoutStatusEnum = pgEnum('payout_status', [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled'
]);

export const payouts = pgTable('payouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id),
  bookingId: uuid('booking_id').references(() => bookings.id),
  
  // Payout amounts
  grossAmount: decimal('gross_amount', { precision: 10, scale: 2 }).notNull(),
  platformFee: decimal('platform_fee', { precision: 10, scale: 2 }).notNull(),
  vat: decimal('vat', { precision: 10, scale: 2 }).notNull(),
  withholdingTax: decimal('withholding_tax', { precision: 10, scale: 2 }).notNull(),
  netAmount: decimal('net_amount', { precision: 10, scale: 2 }).notNull(),
  
  // Payout details
  status: payoutStatusEnum('status').notNull().default('pending'),
  payoutMethod: varchar('payout_method', { length: 20 }).notNull(), // 'mpesa' or 'bank'
  accountDetails: varchar('account_details', { length: 255 }).notNull(),
  
  // Gateway response
  gatewayReference: varchar('gateway_reference', { length: 255 }),
  gatewayResponse: text('gateway_response'),
  
  // Failure handling
  failureReason: text('failure_reason'),
  retryCount: varchar('retry_count', { length: 10 }).default('0'),
  
  // Timestamps
  scheduledAt: timestamp('scheduled_at'),
  processedAt: timestamp('processed_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => {
  return {
    vendorIdx: index('payouts_vendor_idx').on(table.vendorId),
    statusIdx: index('payouts_status_idx').on(table.status),
    scheduledIdx: index('payouts_scheduled_idx').on(table.scheduledAt),
  };
});

export const payoutsRelations = relations(payouts, ({ one }) => ({
  vendor: one(vendors, {
    fields: [payouts.vendorId],
    references: [vendors.id],
  }),
  booking: one(bookings, {
    fields: [payouts.bookingId],
    references: [bookings.id],
  }),
}));