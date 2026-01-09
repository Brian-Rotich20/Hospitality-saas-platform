import { pgTable, uuid, varchar, text, integer, decimal, timestamp, jsonb, pgEnum, boolean, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { vendors } from './vendors';

export const listingStatusEnum = pgEnum('listing_status', ['draft', 'active', 'paused', 'deleted']);
export const listingCategoryEnum = pgEnum('listing_category', ['event_venue', 'catering', 'accommodation', 'other']);

export const listings = pgTable('listings', {
  id: uuid('id').primaryKey().defaultRandom(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  
  // Basic info
  title: varchar('title', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).notNull().unique(),
  description: text('description').notNull(),
  category: listingCategoryEnum('category').notNull(),
  
  // Location
  location: varchar('location', { length: 255 }).notNull(),
  address: text('address').notNull(),
  county: varchar('county', { length: 100 }),
  city: varchar('city', { length: 100 }),
  latitude: decimal('latitude', { precision: 10, scale: 8 }),
  longitude: decimal('longitude', { precision: 11, scale: 8 }),
  
  // Capacity & Details
  capacity: integer('capacity'),
  
  // Pricing
  basePrice: decimal('base_price', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('KES'),
  
  // Media
  photos: jsonb('photos').$type<string[]>().notNull().default([]),
  coverPhoto: varchar('cover_photo', { length: 500 }),
  
  // Features
  amenities: jsonb('amenities').$type<string[]>().default([]),
  
  // Booking settings
  instantBooking: boolean('instant_booking').notNull().default(false),
  minBookingDuration: integer('min_booking_duration').default(1), // in days
  maxBookingDuration: integer('max_booking_duration').default(30),
  leadTime: integer('lead_time').default(1), // minimum days in advance
  
  // Status
  status: listingStatusEnum('status').notNull().default('draft'),
  
  // Metadata
  views: integer('views').default(0),
  bookingsCount: integer('bookings_count').default(0),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => {
  return {
    vendorIdx: index('listings_vendor_idx').on(table.vendorId),
    categoryIdx: index('listings_category_idx').on(table.category),
    statusIdx: index('listings_status_idx').on(table.status),
    locationIdx: index('listings_location_idx').on(table.location),
    slugIdx: index('listings_slug_idx').on(table.slug),
  };
});

// Relations
export const listingsRelations = relations(listings, ({ one }) => ({
  vendor: one(vendors, {
    fields: [listings.vendorId],
    references: [vendors.id],
  }),
}));