import { pgTable, uuid, decimal, varchar, text, timestamp, pgEnum, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { bookings } from './bookings';

export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'processing', 
  'completed',
  'failed',
  'refunded'
]);

export const paymentMethodEnum = pgEnum('payment_method', [
  'mpesa',
  'card',
  'bank_transfer'
]);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id').notNull().references(() => bookings.id),
  
  // Payment details
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('KES'),
  method: paymentMethodEnum('method').notNull(),
  
  // Status
  status: paymentStatusEnum('status').notNull().default('pending'),
  
  // Gateway details
  transactionId: varchar('transaction_id', { length: 255 }),
  gatewayReference: varchar('gateway_reference', { length: 255 }),
  phoneNumber: varchar('phone_number', { length: 20 }),
  
  // Gateway response
  gatewayResponse: jsonb('gateway_response'),
  
  // Failure details
  failureReason: text('failure_reason'),
  retryCount: varchar('retry_count', { length: 10 }).default('0'),
  
  // Timestamps
  paidAt: timestamp('paid_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => {
  return {
    bookingIdx: index('payments_booking_idx').on(table.bookingId),
    statusIdx: index('payments_status_idx').on(table.status),
    transactionIdx: index('payments_transaction_idx').on(table.transactionId),
  };
});

export const paymentsRelations = relations(payments, ({ one }) => ({
  booking: one(bookings, {
    fields: [payments.bookingId],
    references: [bookings.id],
  }),
}));