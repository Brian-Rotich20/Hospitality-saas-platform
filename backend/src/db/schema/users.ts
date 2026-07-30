import { pgTable, uuid, varchar, timestamp, boolean, pgEnum, text } from 'drizzle-orm/pg-core';

export const userRoleEnum = pgEnum('user_role', ['customer', 'vendor', 'admin']);

export const users = pgTable('users', {
  id:                uuid('id').primaryKey().defaultRandom(),
  email:             varchar('email', { length: 255 }).notNull().unique(),
  phone:             varchar('phone', { length: 20 }).unique(),
  passwordHash:      varchar('password_hash', { length: 255 }),
  googleId:     varchar('google_id', { length: 255 }).unique(),
  role:              userRoleEnum('role').notNull().default('customer'),
  vendorId:          uuid('vendor_id'),
  fullName:          varchar('full_name', { length: 255 }),
  avatarUrl:         varchar('avatar_url', { length: 500 }),
  verified:          boolean('verified').notNull().default(false),
  banned: boolean('banned')
    .notNull()
    .default(false),

  banReason: text('ban_reason'),

  banExpires: timestamp('ban_expires'),

  verificationToken: varchar('verification_token', { length: 255 }),
  createdAt:         timestamp('created_at').notNull().defaultNow(),
  updatedAt:         timestamp('updated_at').notNull().defaultNow(),
});