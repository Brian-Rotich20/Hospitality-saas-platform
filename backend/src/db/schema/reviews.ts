// src/db/schema/reviews.ts
import {
  pgTable, uuid, integer, text,
  timestamp, boolean, index, unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { listings }  from './listings';
import { vendors }   from './vendors';
import { bookings }  from './bookings';

// users imported separately to avoid circular
import { users } from './users';

export const reviews = pgTable('reviews', {
  id:         uuid('id').primaryKey().defaultRandom(),

  listingId:  uuid('listing_id').notNull().references(() => listings.id, { onDelete: 'cascade' }),
  vendorId:   uuid('vendor_id').notNull().references(() => vendors.id,   { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => users.id,   { onDelete: 'cascade' }),
  bookingId:  uuid('booking_id').notNull().references(() => bookings.id, { onDelete: 'cascade' }),

  rating:  integer('rating').notNull(),   // 1–5
  title:   text('title'),                 // optional short headline
  body:    text('body').notNull(),         // required review text

  // Vendor can post a public reply
  vendorReply:     text('vendor_reply'),
  vendorRepliedAt: timestamp('vendor_replied_at'),

  // Soft moderation
  isVisible: boolean('is_visible').notNull().default(true),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, table => ({
  listingIdx:  index('reviews_listing_idx').on(table.listingId),
  vendorIdx:   index('reviews_vendor_idx').on(table.vendorId),
  customerIdx: index('reviews_customer_idx').on(table.customerId),

  // One review per booking — prevents duplicates at DB level
  uniqueBooking: unique('reviews_booking_unique').on(table.bookingId),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  listing:  one(listings,  { fields: [reviews.listingId],  references: [listings.id]  }),
  vendor:   one(vendors,   { fields: [reviews.vendorId],   references: [vendors.id]   }),
  customer: one(users,     { fields: [reviews.customerId], references: [users.id]     }),
  booking:  one(bookings,  { fields: [reviews.bookingId],  references: [bookings.id]  }),
}));