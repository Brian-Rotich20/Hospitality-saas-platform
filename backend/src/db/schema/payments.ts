import { pgTable, uuid, decimal, varchar, text, timestamp, pgEnum, jsonb } from 'drizzle-orm/pg-core';
import { bookings } from './bookings';

export const paymentStatusEnum = pgEnum('payment_status', ['pending', 'processing', 'completed', 'failed', 'refunded']);
export const paymentMethodEnum = pgEnum('payment_method', ['mpesa', 'card', 'bank_transfer']);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  bookingId: uuid('booking_id').notNull().references(() => bookings.id),
  amount: decimal('amount', { precision: 10, scale: 2 }).notNull(),
  method: paymentMethodEnum('method').notNull(),
  status: paymentStatusEnum('status').notNull().default('pending'),
  transactionId: varchar('transaction_id', { length: 255 }),
  phoneNumber: varchar('phone_number', { length: 20 }),
  gatewayResponse: jsonb('gateway_response'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});