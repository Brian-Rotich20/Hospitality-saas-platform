import { pgTable, uuid, varchar, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { users } from './users';

export const vendorStatusEnum = pgEnum('vendor_status', ['pending', 'approved', 'rejected', 'suspended']);

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  businessName: varchar('business_name', { length: 255 }).notNull(),
  businessType: varchar('business_type', { length: 100 }).notNull(),
  businessRegistration: varchar('business_registration', { length: 255 }),
  taxPin: varchar('tax_pin', { length: 50 }),
  mpesaNumber: varchar('mpesa_number', { length: 20 }),
  bankAccountName: varchar('bank_account_name', { length: 255 }),
  bankAccountNumber: varchar('bank_account_number', { length: 50 }),
  bankName: varchar('bank_name', { length: 100 }),
  status: vendorStatusEnum('status').notNull().default('pending'),
  rejectionReason: text('rejection_reason'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});