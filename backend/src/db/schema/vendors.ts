import { pgTable, uuid, varchar, text, timestamp, pgEnum, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';

export const vendorStatusEnum = pgEnum('vendor_status', ['pending', 'approved', 'rejected', 'suspended']);
export const businessTypeEnum = pgEnum('business_type', ['event_venue', 'catering', 'accommodation', 'other']);

export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  businessName: varchar('business_name', { length: 255 }).notNull(),
  businessType: businessTypeEnum('business_type').notNull(),
  businessRegistration: varchar('business_registration', { length: 255 }),
  taxPin: varchar('tax_pin', { length: 50 }),
  phoneNumber: varchar('phone_number', { length: 20 }).notNull(),
  location: varchar('location', { length: 255 }).notNull(),
  description: text('description').notNull(),
  
  // Payout details
  payoutMethod: varchar('payout_method', { length: 20 }),
  mpesaNumber: varchar('mpesa_number', { length: 20 }),
  bankAccountName: varchar('bank_account_name', { length: 255 }),
  bankAccountNumber: varchar('bank_account_number', { length: 50 }),
  bankName: varchar('bank_name', { length: 100 }),
  
  status: vendorStatusEnum('status').notNull().default('pending'),
  rejectionReason: text('rejection_reason'),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at'),
  
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Vendor documents table
export const vendorDocuments = pgTable('vendor_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  vendorId: uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  documentType: varchar('document_type', { length: 50 }).notNull(), // 'business_registration', 'tax_pin', 'national_id'
  documentUrl: varchar('document_url', { length: 500 }).notNull(),
  fileName: varchar('file_name', { length: 255 }).notNull(),
  fileSize: varchar('file_size', { length: 20 }),
  uploadedAt: timestamp('uploaded_at').notNull().defaultNow(),
});

// Relations
export const vendorsRelations = relations(vendors, ({ one, many }) => ({
  user: one(users, {
    fields: [vendors.userId],
    references: [users.id],
  }),
  documents: many(vendorDocuments),
}));

export const vendorDocumentsRelations = relations(vendorDocuments, ({ one }) => ({
  vendor: one(vendors, {
    fields: [vendorDocuments.vendorId],
    references: [vendors.id],
  }),
}));