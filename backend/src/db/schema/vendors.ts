import { pgTable, uuid, varchar, text, timestamp, pgEnum, boolean, index, integer } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';

export const vendorStatusEnum = pgEnum('vendor_status', [
  'pending_verification',
  'pending',
  'approved',
  'rejected',
  'suspended',
]);

export const vendors = pgTable('vendors', {
  id:     uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),

  // Business identity
  businessName:         varchar('business_name', { length: 255 }).notNull(),
  slug:                 varchar('slug', { length: 255 }).notNull().unique(),
  description:          text('description'),
  businessRegistration: varchar('business_registration', { length: 255 }),
  taxPin:               varchar('tax_pin', { length: 50 }),

  // Contact
  phoneNumber:  varchar('phone_number', { length: 20 }),
  whatsappNumber: varchar('whatsapp_number', { length: 20 }), // for product enquiries
  email:        varchar('email', { length: 255 }),
  website:      varchar('website', { length: 500 }),

  // Location (vendor's primary base — listings have their own locations)
  city:   varchar('city', { length: 100 }),
  county: varchar('county', { length: 100 }),

  // Media
  logo:       varchar('logo', { length: 500 }),
  coverPhoto: varchar('cover_photo', { length: 500 }),

  // Trust
  verified: boolean('verified').notNull().default(false),

  // Payout details
  payoutMethod:      varchar('payout_method', { length: 20 }),  // 'mpesa' | 'bank'
  mpesaNumber:       varchar('mpesa_number', { length: 20 }),
  bankAccountName:   varchar('bank_account_name', { length: 255 }),
  bankAccountNumber: varchar('bank_account_number', { length: 50 }),
  bankName:          varchar('bank_name', { length: 100 }),

  // Admin
  status:          vendorStatusEnum('status').notNull().default('pending'),
  onboardingStep: integer('onboarding_step').notNull().default(0),
  rejectionReason: text('rejection_reason'),
  approvedBy:      uuid('approved_by').references(() => users.id),
  approvedAt:      timestamp('approved_at'),

  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => ({
  userIdx:   index('vendors_user_idx').on(table.userId),
  slugIdx:   index('vendors_slug_idx').on(table.slug),
  statusIdx: index('vendors_status_idx').on(table.status),
}));

export const vendorDocuments = pgTable('vendor_documents', {
  id:           uuid('id').primaryKey().defaultRandom(),
  vendorId:     uuid('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  documentType: varchar('document_type', { length: 50 }).notNull(),
  documentUrl:  varchar('document_url', { length: 500 }).notNull(),
  fileName:     varchar('file_name', { length: 255 }).notNull(),
  fileSize:     varchar('file_size', { length: 20 }),
  uploadedAt:   timestamp('uploaded_at').notNull().defaultNow(),
});

export const vendorsRelations = relations(vendors, ({ one, many }) => ({
  user:      one(users, { fields: [vendors.userId], references: [users.id] }),
  documents: many(vendorDocuments),
}));

export const vendorDocumentsRelations = relations(vendorDocuments, ({ one }) => ({
  vendor: one(vendors, { fields: [vendorDocuments.vendorId], references: [vendors.id] }),
}));