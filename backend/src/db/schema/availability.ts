import { pgTable, uuid, date, boolean, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { listings } from './listings';

export const availability = pgTable('availability', {
  id: uuid('id').primaryKey().defaultRandom(),
  listingId: uuid('listing_id').notNull().references(() => listings.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  available: boolean('available').notNull().default(true),
  blockedReason: text('blocked_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => {
  return {
    listingDateIdx: index('availability_listing_date_idx').on(table.listingId, table.date),
    uniqueListingDate: unique('unique_listing_date').on(table.listingId, table.date),
  };
});

export const availabilityRelations = relations(availability, ({ one }) => ({
  listing: one(listings, {
    fields: [availability.listingId],
    references: [listings.id],
  }),
}));