import {
  pgTable, uuid, varchar, text, integer, decimal,
  timestamp, jsonb, pgEnum, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { vendors }    from './vendors.js';
import { categories } from './categories.js';

// ✅ Updated enum — old one had 'fixed' | 'range', now aligned
export const pricingTypeEnum = pgEnum('pricing_type', [
  'per_hour', 'per_day', 'per_person', 'package', 'contact',
]);

export const listingStatusEnum = pgEnum('listing_status', [
  'draft', 'active', 'paused', 'deleted',
]);

export const listings = pgTable('listings', {
  // ✅ Drizzle maps uuid('vendor_id') → JS key must match what you pass
  // The column is vendor_id in DB, but Drizzle key here is vendorId
  id:         uuid('id').primaryKey().defaultRandom(),
  vendorId:   uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => categories.id),

  title:       varchar('title',       { length: 255 }).notNull(),
  slug:        varchar('slug',        { length: 255 }).notNull().unique(),
  description: text('description').notNull(),

  location: jsonb('location').$type<{
    county:     string;
    area:       string;
    country?:   string | undefined;
    latitude?:  number | undefined;
    longitude?: number | undefined;
  }>().notNull(),

  pricingType: pricingTypeEnum('pricing_type').notNull().default('per_day'),
  price:       decimal('price',     { precision: 10, scale: 2 }),
  minPrice:    decimal('min_price', { precision: 10, scale: 2 }),
  maxPrice:    decimal('max_price', { precision: 10, scale: 2 }),
  currency:    varchar('currency',  { length: 3 }).notNull().default('KES'),

  photos:     jsonb('photos').$type<string[]>().notNull().default([]),
  coverPhoto: varchar('cover_photo', { length: 500 }),

  status:        listingStatusEnum('status').notNull().default('draft'),
  views:         integer('views').notNull().default(0),
  bookingsCount: integer('bookings_count').notNull().default(0),
  rating:      decimal('rating',       { precision: 3, scale: 1 }),   // e.g. 4.7
  reviewCount: integer('review_count').notNull().default(0),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  vendorIdx:   index('listings_vendor_idx').on(table.vendorId),
  categoryIdx: index('listings_category_idx').on(table.categoryId),
  statusIdx:   index('listings_status_idx').on(table.status),
  slugIdx:     index('listings_slug_idx').on(table.slug),
}));

export const listingsRelations = relations(listings, ({ one }) => ({
  vendor: one(vendors, {
    fields:     [listings.vendorId],
    references: [vendors.id],
  }),
  category: one(categories, {
    fields:     [listings.categoryId],
    references: [categories.id],
  }),
}));