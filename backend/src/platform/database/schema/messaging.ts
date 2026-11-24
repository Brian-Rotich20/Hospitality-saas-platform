// Booking-scoped customer–vendor messaging. A conversation is opened when the vendor
// accepts a request; only the booking's customer and the listing's vendor take part.
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index, uniqueIndex, varchar, check } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { bookings } from './bookings.js';
import { users } from './users.js';
import { vendors } from './vendors.js';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const conversations = pgTable('conversations', {
  id:         uuid('id').primaryKey().defaultRandom(),
  bookingId:  uuid('booking_id').notNull().references(() => bookings.id),
  customerId: uuid('customer_id').notNull().references(() => users.id),
  vendorId:   uuid('vendor_id').notNull().references(() => vendors.id),
  lastMessageAt: tz('last_message_at'),
  createdAt:  tz('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('conversations_booking_unique').on(t.bookingId),
  index('conversations_customer_idx').on(t.customerId, t.lastMessageAt),
  index('conversations_vendor_idx').on(t.vendorId, t.lastMessageAt),
]);

export const messages = pgTable('messages', {
  id:             uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id),
  senderUserId:   uuid('sender_user_id').notNull().references(() => users.id),
  body:           text('body').notNull(),
  /** Moderation: hidden messages stay stored for audit but are not shown. */
  hiddenAt:       tz('hidden_at'),
  hiddenBy:       uuid('hidden_by').references(() => users.id),
  createdAt:      tz('created_at').notNull().defaultNow(),
}, (t) => [
  index('messages_conversation_idx').on(t.conversationId, t.createdAt),
  index('messages_sender_idx').on(t.senderUserId),
  index('messages_hidden_by_idx').on(t.hiddenBy),
  check('messages_body_length', sql`char_length(${t.body}) between 1 and 2000`),
]);

export const messageReports = pgTable('message_reports', {
  id:         uuid('id').primaryKey().defaultRandom(),
  messageId:  uuid('message_id').notNull().references(() => messages.id),
  reporterId: uuid('reporter_id').notNull().references(() => users.id),
  reason:     varchar('reason', { length: 500 }).notNull(),
  resolvedAt: tz('resolved_at'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolution: varchar('resolution', { length: 20 }),
  createdAt:  tz('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('message_reports_unique').on(t.messageId, t.reporterId),
  index('message_reports_open_idx').on(t.createdAt).where(sql`resolved_at is null`),
  index('message_reports_reporter_idx').on(t.reporterId),
  index('message_reports_resolved_by_idx').on(t.resolvedBy),
]);

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  booking: one(bookings, { fields: [conversations.bookingId], references: [bookings.id] }),
  messages: many(messages),
}));
export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
}));
