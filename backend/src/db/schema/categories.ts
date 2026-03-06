import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Self-referencing table — supports unlimited parent/child categories
// e.g. Venues > Wedding Venue > Garden Wedding Venue
export const categories = pgTable('categories', {
  id:       uuid('id').primaryKey().defaultRandom(),
  name:     varchar('name', { length: 100 }).notNull(),
  slug:     varchar('slug', { length: 100 }).notNull().unique(),

  // Lucide icon name e.g. 'building-2', 'utensils', 'camera'
  icon:     varchar('icon', { length: 50 }),

  // null = top-level category
  parentId: uuid('parent_id'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  parentIdx: index('categories_parent_idx').on(table.parentId),
  slugIdx:   index('categories_slug_idx').on(table.slug),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent:   one(categories, {
    fields:     [categories.parentId],
    references: [categories.id],
    relationName: 'subcategories',
  }),
  children: many(categories, { relationName: 'subcategories' }),
}));