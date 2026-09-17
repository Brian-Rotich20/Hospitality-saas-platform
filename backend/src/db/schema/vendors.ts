import { pgTable, uuid, varchar, timestamp, pgEnum, boolean, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users.js';

export const vendorStatusEnum = pgEnum('vendor_status', [
  'approved',
  'suspended',
]);

export const vendors = pgTable('vendors', {
  id:     uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),

  // Business identity
  businessName: varchar('business_name', { length: 255 }).notNull(),
  slug:         varchar('slug', { length: 255 }).notNull().unique(),

  // Contact
  phoneNumber: varchar('phone_number', { length: 20 }),

  // Media
  logo: varchar('logo', { length: 500 }),

  // Trust
  verified: boolean('verified').notNull().default(false),

  // Payout details
  payoutMethod:      varchar('payout_method', { length: 20 }),  // 'mpesa' | 'bank'
  mpesaNumber:       varchar('mpesa_number', { length: 20 }),
  bankAccountName:   varchar('bank_account_name', { length: 255 }),
  bankAccountNumber: varchar('bank_account_number', { length: 50 }),
  bankName:          varchar('bank_name', { length: 100 }),

  // Admin
  status: vendorStatusEnum('status').notNull().default('approved'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdx:   index('vendors_user_idx').on(table.userId),
  slugIdx:   index('vendors_slug_idx').on(table.slug),
  statusIdx: index('vendors_status_idx').on(table.status),
}));

export const vendorsRelations = relations(vendors, ({ one }) => ({
  user: one(users, { fields: [vendors.userId], references: [users.id] }),
}));

