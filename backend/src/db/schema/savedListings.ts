// src/db/schema/savedListings.ts
import {
  pgTable, uuid, timestamp, index, unique,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users }    from './users.js';
import { listings } from './listings.js';

export const savedListings = pgTable('saved_listings', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull().references(() => users.id,    { onDelete: 'cascade' }),
  listingId:  uuid('listing_id').notNull().references(() => listings.id, { onDelete: 'cascade' }),
  createdAt:  timestamp('created_at').notNull().defaultNow(),
}, table => ({
  userIdx:    index('saved_user_idx').on(table.userId),
  // One save per listing per user
  uniqueSave: unique('saved_unique').on(table.userId, table.listingId),
}));

export const savedListingsRelations = relations(savedListings, ({ one }) => ({
  user:    one(users,    { fields: [savedListings.userId],    references: [users.id]    }),
  listing: one(listings, { fields: [savedListings.listingId], references: [listings.id] }),
}));