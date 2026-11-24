// Cross-cutting tables: transactional outbox, audit log, owner-tracked uploads.
import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, jsonb, timestamp, integer, text, index, uniqueIndex, bigint } from 'drizzle-orm/pg-core';
import { users } from './users.js';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Transactional outbox. Rows are written in the same transaction as the state change
 * they describe; the worker delivers them (email today) at least once. `dedupeKey`
 * makes scheduled notifications (reminders) exactly-once to enqueue.
 */
export const outbox = pgTable('outbox', {
  id:        uuid('id').primaryKey().defaultRandom(),
  topic:     varchar('topic', { length: 100 }).notNull(),
  payload:   jsonb('payload').$type<Record<string, unknown>>().notNull(),
  dedupeKey: varchar('dedupe_key', { length: 200 }),
  availableAt: tz('available_at').notNull().defaultNow(),
  attempts:  integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  /** How many of the row's emails were already sent, so a retry never re-sends them. */
  deliveredCount: integer('delivered_count').notNull().default(0),
  processedAt: tz('processed_at'),
  /** Dead-lettered: retries exhausted or the row can never be delivered. Retried only by an admin. */
  failedAt:  tz('failed_at'),
  createdAt: tz('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('outbox_dedupe_unique').on(t.dedupeKey),
  index('outbox_pending_idx').on(t.availableAt).where(sql`processed_at is null and failed_at is null`),
  index('outbox_failed_idx').on(t.failedAt).where(sql`failed_at is not null and processed_at is null`),
]);

/** Append-only record of administrative and security-relevant actions. */
export const auditLog = pgTable('audit_log', {
  id:         uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  actorType:  varchar('actor_type', { length: 20 }).notNull(), // user | admin | system | provider
  action:     varchar('action', { length: 100 }).notNull(),
  entityType: varchar('entity_type', { length: 50 }).notNull(),
  entityId:   varchar('entity_id', { length: 100 }).notNull(),
  details:    jsonb('details').$type<Record<string, unknown>>(),
  requestId:  varchar('request_id', { length: 100 }),
  createdAt:  tz('created_at').notNull().defaultNow(),
}, (t) => [
  index('audit_log_entity_idx').on(t.entityType, t.entityId, t.createdAt),
  index('audit_log_actor_idx').on(t.actorUserId, t.createdAt),
]);

/** Files uploaded through the API, with their owner, so deletion can be authorised. */
export const uploads = pgTable('uploads', {
  id:         uuid('id').primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id').notNull().references(() => users.id),
  purpose:    varchar('purpose', { length: 30 }).notNull(), // listing_photo | profile_photo | vendor_logo
  provider:   varchar('provider', { length: 20 }).notNull(),
  publicId:   varchar('public_id', { length: 255 }).notNull(),
  url:        text('url').notNull(),
  bytes:      bigint('bytes', { mode: 'number' }).notNull(),
  mimeType:   varchar('mime_type', { length: 100 }).notNull(),
  deletedAt:  tz('deleted_at'),
  createdAt:  tz('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('uploads_public_id_unique').on(t.provider, t.publicId),
  index('uploads_owner_idx').on(t.ownerUserId, t.createdAt),
]);
