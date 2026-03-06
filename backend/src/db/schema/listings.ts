import { pgTable, uuid, varchar, text, integer, decimal, timestamp, jsonb, pgEnum, boolean, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { vendors } from './vendors';
import { categories } from './categories';


export const pricingTypeEnum = pgEnum('pricing_type', [
  'fixed', 'per_day', 'per_hour', 'per_person', 'range', 'package',
]);
export const listingStatusEnum = pgEnum('listing_status', [
  'draft', 'active', 'paused', 'deleted',
]);
export const listings = pgTable('listings', {
  id:       uuid('id').primaryKey().defaultRandom(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  categoryId: uuid('category_id').notNull().references(() => categories.id),

  title:       varchar('title', { length: 255 }).notNull(),
  slug:        varchar('slug', { length: 255 }).notNull().unique(),
  description: text('description').notNull(),

  // jsonb replaces all flat location fields
  location: jsonb('location').$type<{
  address?: string | undefined;
  city: string;
  county?: string | undefined;
  country?: string | undefined;
  latitude?: number | undefined;
  longitude?: number | undefined;
}>().notNull(),

  capacity: integer('capacity'),

  // Flexible pricing — replaces basePrice
  pricingType: pricingTypeEnum('pricing_type').notNull().default('fixed'),
  price:       decimal('price',     { precision: 10, scale: 2 }),
  minPrice:    decimal('min_price', { precision: 10, scale: 2 }),
  maxPrice:    decimal('max_price', { precision: 10, scale: 2 }),
  currency:    varchar('currency', { length: 3 }).notNull().default('KES'),

  photos:     jsonb('photos').$type<string[]>().notNull().default([]),
  coverPhoto: varchar('cover_photo', { length: 500 }),
  amenities:  jsonb('amenities').$type<string[]>().default([]),

  instantBooking:     boolean('instant_booking').notNull().default(false),
  minBookingDuration: integer('min_booking_duration').default(1),
  maxBookingDuration: integer('max_booking_duration').default(30),
  leadTime:           integer('lead_time').default(1),

  status:        listingStatusEnum('status').notNull().default('draft'),
  views:         integer('views').notNull().default(0),
  bookingsCount: integer('bookings_count').notNull().default(0),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  vendorIdx:   index('listings_vendor_idx').on(table.vendorId),
  categoryIdx: index('listings_category_idx').on(table.categoryId),
  statusIdx:   index('listings_status_idx').on(table.status),
  slugIdx:     index('listings_slug_idx').on(table.slug),
}));

// Relations
export const listingsRelations = relations(listings, ({ one }) => ({
  vendor: one(vendors, {
    fields: [listings.vendorId],
    references: [vendors.id],
  }),
  category: one(categories, {
    fields: [listings.categoryId],
    references: [categories.id],
  }),
}));