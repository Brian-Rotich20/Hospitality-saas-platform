import {
  pgTable, uuid, varchar, text, integer, decimal,
  timestamp, jsonb, pgEnum, boolean, index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { vendors } from './vendors';
import { categories } from './categories';

export const productStatusEnum = pgEnum('product_status', [
  'draft',
  'active',
  'paused',
  'out_of_stock',
  'deleted',
]);

// ─── Products ────────────────────────────────────────────────────────────────
// Physical or digital items a vendor sells directly.
// Purchase flow: customer sees product → taps WhatsApp button → vendor notified
// No cart, no checkout — direct contact like Jiji.

export const products = pgTable('products', {
  id:       uuid('id').primaryKey().defaultRandom(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),

  // Category — same dynamic categories table as listings
  categoryId: uuid('category_id').references(() => categories.id),

  // Basic info
  title:       varchar('title', { length: 255 }).notNull(),
  slug:        varchar('slug', { length: 255 }).notNull().unique(),
  description: text('description'),

  // Pricing — simple for now (products don't need per_person etc.)
  price:    decimal('price', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('KES'),

  // Media
  photos:     jsonb('photos').$type<string[]>().notNull().default([]),
  coverPhoto: varchar('cover_photo', { length: 500 }),

  // Enquiry via WhatsApp — pre-filled message
  whatsappMessage: text('whatsapp_message'), // e.g. "Hi, I'm interested in [product name]"

  // Product type
  isDigital: boolean('is_digital').notNull().default(false),

  // Status & stock
  status: productStatusEnum('status').notNull().default('draft'),

  // Stats
  views: integer('views').notNull().default(0),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  vendorIdx:   index('products_vendor_idx').on(table.vendorId),
  categoryIdx: index('products_category_idx').on(table.categoryId),
  statusIdx:   index('products_status_idx').on(table.status),
  slugIdx:     index('products_slug_idx').on(table.slug),
}));

// ─── Product Variants ─────────────────────────────────────────────────────────
// e.g. a decor vendor sells centerpieces in Small / Medium / Large
// e.g. a cake vendor offers 1kg / 2kg / 3kg options

export const productVariants = pgTable('product_variants', {
  id:        uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),

  name:  varchar('name', { length: 100 }).notNull(), // e.g. "Small", "2kg", "Red"
  price: decimal('price', { precision: 10, scale: 2 }), // override base price if different

  // Flexible attributes: { color: 'Red', size: 'Large', weight: '2kg' }
  attributes: jsonb('attributes').$type<Record<string, string>>().default({}),

  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  productIdx: index('variants_product_idx').on(table.productId),
}));

// ─── Product Inventory ────────────────────────────────────────────────────────
// Tracks stock per product (or per variant if variants exist)

export const productInventory = pgTable('product_inventory', {
  id:        uuid('id').primaryKey().defaultRandom(),
  productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }).unique(),
  variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'cascade' }),

  quantity:    integer('quantity').notNull().default(0),
  lowStockAt:  integer('low_stock_at').default(5),  // trigger low stock alert below this
  trackStock:  boolean('track_stock').notNull().default(true),

  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  productIdx: index('inventory_product_idx').on(table.productId),
}));

// ─── Relations ────────────────────────────────────────────────────────────────

export const productsRelations = relations(products, ({ one, many }) => ({
  vendor:    one(vendors,    { fields: [products.vendorId],   references: [vendors.id]    }),
  category:  one(categories, { fields: [products.categoryId], references: [categories.id] }),
  variants:  many(productVariants),
  inventory: many(productInventory),
}));

export const productVariantsRelations = relations(productVariants, ({ one }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
}));

export const productInventoryRelations = relations(productInventory, ({ one }) => ({
  product: one(products,        { fields: [productInventory.productId], references: [products.id]        }),
  variant: one(productVariants, { fields: [productInventory.variantId], references: [productVariants.id] }),
}));