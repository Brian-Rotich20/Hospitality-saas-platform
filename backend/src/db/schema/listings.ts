import { pgTable, uuid, varchar, text, integer, decimal, timestamp, jsonb, pgEnum, boolean } from 'drizzle-orm/pg-core';
import { vendors } from './vendors';

export const listingStatusEnum = pgEnum('listing_status', ['draft', 'active', 'paused', 'deleted']);
export const listingCategoryEnum = pgEnum('listing_category', ['event_venue', 'catering', 'accommodation']);

export const listings = pgTable('listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  category: listingCategoryEnum('category').notNull(),
  location: varchar('location', { length: 255 }).notNull(),
  address: text('address').notNull(),
  latitude: decimal('latitude', { precision: 10, scale: 8 }),
  longitude: decimal('longitude', { precision: 11, scale: 8 }),
  capacity: integer('capacity'),
  basePrice: decimal('base_price', { precision: 10, scale: 2 }).notNull(),
  photos: jsonb('photos').$type<string[]>().notNull().default([]),
  amenities: jsonb('amenities').$type<string[]>().default([]),
  instantBooking: boolean('instant_booking').notNull().default(false),
  status: listingStatusEnum('status').notNull().default('draft'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});