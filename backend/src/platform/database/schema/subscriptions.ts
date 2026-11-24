// Vendor subscriptions: LinkMart's only revenue and the only payments it processes.
// Money is stored as integer minor units (bigint) with an explicit ISO currency code.
// Financial rows (invoices, attempts, provider events, revenue entries) are append-only
// or state-forward only; nothing here is ever deleted.
import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, varchar, bigint, boolean, timestamp, text, jsonb, index, uniqueIndex, integer, check,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { vendors } from './vendors.js';
import { users } from './users.js';

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const money = (name: string) => bigint(name, { mode: 'number' });

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired',
]);
export const invoiceStatusEnum = pgEnum('subscription_invoice_status', ['open', 'paid', 'void']);
export const paymentProviderEnum = pgEnum('payment_provider', ['paystack', 'daraja']);
export const paymentAttemptStatusEnum = pgEnum('payment_attempt_status', [
  'initiated', 'pending', 'succeeded', 'failed', 'reversed', 'cancelled',
]);
export const revenueEntryTypeEnum = pgEnum('revenue_entry_type', ['subscription_payment', 'reversal', 'refund']);

/** Admin-configured price. A price change creates a new plan row; history is kept. */
export const subscriptionPlans = pgTable('subscription_plans', {
  id:          uuid('id').primaryKey().defaultRandom(),
  code:        varchar('code', { length: 50 }).notNull(),
  name:        varchar('name', { length: 100 }).notNull(),
  amountMinor: money('amount_minor').notNull(),
  currency:    varchar('currency', { length: 3 }).notNull(),
  interval:    varchar('interval', { length: 10 }).notNull().default('month'),
  isActive:    boolean('is_active').notNull().default(false),
  createdBy:   uuid('created_by').references(() => users.id),
  createdAt:   tz('created_at').notNull().defaultNow(),
  deactivatedAt: tz('deactivated_at'),
}, (t) => [
  check('subscription_plans_amount_positive', sql`${t.amountMinor} > 0`),
  check('subscription_plans_interval_month', sql`${t.interval} = 'month'`),
  // At most one plan is offered at a time.
  uniqueIndex('subscription_plans_one_active').on(t.isActive).where(sql`is_active`),
  index('subscription_plans_created_by_idx').on(t.createdBy),
]);

export const vendorSubscriptions = pgTable('vendor_subscriptions', {
  id:        uuid('id').primaryKey().defaultRandom(),
  vendorId:  uuid('vendor_id').notNull().references(() => vendors.id),
  status:    subscriptionStatusEnum('status').notNull(),
  planId:    uuid('plan_id').references(() => subscriptionPlans.id),
  trialStartedAt: tz('trial_started_at').notNull(),
  trialEndsAt:    tz('trial_ends_at').notNull(),
  currentPeriodStart: tz('current_period_start'),
  currentPeriodEnd:   tz('current_period_end'),
  /** Set when an invoice becomes due; past this instant an unpaid subscription is suspended. */
  graceEndsAt:   tz('grace_ends_at'),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  cancelledAt:   tz('cancelled_at'),
  suspendedAt:   tz('suspended_at'),
  expiredAt:     tz('expired_at'),
  /** Why billing could not proceed (e.g. no active plan configured). Null when billing is healthy. */
  billingHoldReason: varchar('billing_hold_reason', { length: 50 }),
  /** Paystack saved-card renewal: opt-in by the vendor, only with a reusable authorization. */
  autoRenewOptIn: boolean('auto_renew_opt_in').notNull().default(false),
  paystackAuthorizationCode: text('paystack_authorization_code'),
  paystackCustomerEmail: varchar('paystack_customer_email', { length: 255 }),
  /** Explicit record of how this subscription was created. */
  origin: varchar('origin', { length: 30 }).notNull().default('onboarding'),
  createdAt: tz('created_at').notNull().defaultNow(),
  updatedAt: tz('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('vendor_subscriptions_vendor_unique').on(t.vendorId),
  index('vendor_subscriptions_status_idx').on(t.status),
  index('vendor_subscriptions_plan_idx').on(t.planId),
  check('vendor_subscriptions_trial_order', sql`${t.trialEndsAt} > ${t.trialStartedAt}`),
]);

export const subscriptionInvoices = pgTable('subscription_invoices', {
  id:             uuid('id').primaryKey().defaultRandom(),
  subscriptionId: uuid('subscription_id').notNull().references(() => vendorSubscriptions.id),
  vendorId:       uuid('vendor_id').notNull().references(() => vendors.id),
  planId:         uuid('plan_id').notNull().references(() => subscriptionPlans.id),
  amountMinor:    money('amount_minor').notNull(),
  currency:       varchar('currency', { length: 3 }).notNull(),
  periodStart:    tz('period_start').notNull(),
  periodEnd:      tz('period_end').notNull(),
  dueAt:          tz('due_at').notNull(),
  status:         invoiceStatusEnum('status').notNull().default('open'),
  paidAt:         tz('paid_at'),
  paidByAttemptId: uuid('paid_by_attempt_id'),
  voidedAt:       tz('voided_at'),
  voidReason:     varchar('void_reason', { length: 100 }),
  createdAt:      tz('created_at').notNull().defaultNow(),
}, (t) => [
  // One invoice per subscription per billing period: renewal is idempotent.
  uniqueIndex('subscription_invoices_period_unique').on(t.subscriptionId, t.periodStart),
  index('subscription_invoices_vendor_idx').on(t.vendorId, t.createdAt),
  index('subscription_invoices_open_idx').on(t.status).where(sql`status = 'open'`),
  index('subscription_invoices_plan_idx').on(t.planId),
  check('subscription_invoices_amount_positive', sql`${t.amountMinor} > 0`),
  check('subscription_invoices_period_order', sql`${t.periodEnd} > ${t.periodStart}`),
]);

export const paymentAttempts = pgTable('payment_attempts', {
  id:         uuid('id').primaryKey().defaultRandom(),
  invoiceId:  uuid('invoice_id').notNull().references(() => subscriptionInvoices.id),
  vendorId:   uuid('vendor_id').notNull().references(() => vendors.id),
  provider:   paymentProviderEnum('provider').notNull(),
  status:     paymentAttemptStatusEnum('status').notNull().default('initiated'),
  amountMinor: money('amount_minor').notNull(),
  currency:   varchar('currency', { length: 3 }).notNull(),
  /** Client-supplied (Idempotency-Key header) or server-generated; one attempt per key. */
  idempotencyKey: varchar('idempotency_key', { length: 100 }).notNull(),
  /** Paystack transaction reference, or Daraja CheckoutRequestID. */
  providerReference: varchar('provider_reference', { length: 100 }),
  /** Daraja MerchantRequestID / Paystack transaction id. */
  providerSecondaryReference: varchar('provider_secondary_reference', { length: 100 }),
  /** M-Pesa receipt number or Paystack channel receipt, once verified. */
  providerReceipt: varchar('provider_receipt', { length: 100 }),
  /** MSISDN for STK Push, stored masked except the last 3 digits. */
  phoneMasked: varchar('phone_masked', { length: 20 }),
  checkoutUrl: text('checkout_url'),
  failureReason: text('failure_reason'),
  /** Sanitised provider data needed for audit and reconciliation (no secrets, no tokens). */
  providerMetadata: jsonb('provider_metadata').$type<Record<string, unknown>>(),
  initiatedBy: varchar('initiated_by', { length: 20 }).notNull().default('vendor'),
  verifiedAt:  tz('verified_at'),
  completedAt: tz('completed_at'),
  /** Set when the provider reversed or refunded a credited payment (full amount). */
  reversedAt:  tz('reversed_at'),
  /**
   * Needs a human: money may have moved but was not (or no longer) applied automatically
   * (amount/currency/reference mismatch, payment for a settled invoice, provider reversal,
   * dispute). Review is investigative only: it never moves money or changes access.
   */
  requiresReview: boolean('requires_review').notNull().default(false),
  reviewReason: varchar('review_reason', { length: 100 }),
  reviewedAt:  tz('reviewed_at'),
  reviewedBy:  uuid('reviewed_by').references(() => users.id),
  reviewNote:  text('review_note'),
  createdAt:   tz('created_at').notNull().defaultNow(),
  updatedAt:   tz('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('payment_attempts_idempotency_unique').on(t.vendorId, t.idempotencyKey),
  uniqueIndex('payment_attempts_provider_ref_unique').on(t.provider, t.providerReference),
  index('payment_attempts_invoice_idx').on(t.invoiceId),
  index('payment_attempts_pending_idx').on(t.status, t.createdAt).where(sql`status in ('initiated','pending')`),
  index('payment_attempts_reviewed_by_idx').on(t.reviewedBy),
  index('payment_attempts_review_idx').on(t.createdAt).where(sql`requires_review and reviewed_at is null`),
  check('payment_attempts_amount_positive', sql`${t.amountMinor} > 0`),
]);

/** Every inbound webhook/callback, stored before processing. The idempotency boundary. */
export const providerEvents = pgTable('provider_events', {
  id:        uuid('id').primaryKey().defaultRandom(),
  provider:  paymentProviderEnum('provider').notNull(),
  /** Provider's unique event identity (e.g. Paystack event+reference+id, Daraja CheckoutRequestID+ResultCode). */
  eventKey:  varchar('event_key', { length: 200 }).notNull(),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  payload:   jsonb('payload').$type<unknown>().notNull(),
  attemptId: uuid('attempt_id').references(() => paymentAttempts.id),
  receivedAt:  tz('received_at').notNull().defaultNow(),
  processedAt: tz('processed_at'),
  processingAttempts: integer('processing_attempts').notNull().default(0),
  lastError: text('last_error'),
}, (t) => [
  uniqueIndex('provider_events_key_unique').on(t.provider, t.eventKey),
  index('provider_events_unprocessed_idx').on(t.receivedAt).where(sql`processed_at is null`),
  // Provider transactions with no matching payment attempt (investigation queue).
  index('provider_events_unmatched_idx').on(t.receivedAt).where(sql`attempt_id is null`),
  index('provider_events_attempt_idx').on(t.attemptId),
]);

/**
 * Append-only revenue journal. A succeeded subscription payment writes one positive
 * entry; reversals/refunds write negative entries referencing the same attempt.
 * Revenue reporting sums this table, never payment statuses.
 */
export const revenueEntries = pgTable('revenue_entries', {
  id:          uuid('id').primaryKey().defaultRandom(),
  entryType:   revenueEntryTypeEnum('entry_type').notNull(),
  vendorId:    uuid('vendor_id').notNull().references(() => vendors.id),
  invoiceId:   uuid('invoice_id').notNull().references(() => subscriptionInvoices.id),
  attemptId:   uuid('attempt_id').notNull().references(() => paymentAttempts.id),
  amountMinor: money('amount_minor').notNull(),
  currency:    varchar('currency', { length: 3 }).notNull(),
  provider:    paymentProviderEnum('provider').notNull(),
  providerReference: varchar('provider_reference', { length: 100 }),
  /** True when the payment arrived for an invoice that was already settled or void: needs admin review. */
  requiresReview: boolean('requires_review').notNull().default(false),
  occurredAt:  tz('occurred_at').notNull(),
  createdAt:   tz('created_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('revenue_entries_attempt_type_unique').on(t.attemptId, t.entryType),
  index('revenue_entries_occurred_idx').on(t.occurredAt),
  index('revenue_entries_vendor_idx').on(t.vendorId, t.occurredAt),
  index('revenue_entries_invoice_idx').on(t.invoiceId),
  check('revenue_entries_sign', sql`(${t.entryType} = 'subscription_payment' and ${t.amountMinor} > 0) or (${t.entryType} <> 'subscription_payment' and ${t.amountMinor} < 0)`),
]);

export const vendorSubscriptionsRelations = relations(vendorSubscriptions, ({ one, many }) => ({
  vendor: one(vendors, { fields: [vendorSubscriptions.vendorId], references: [vendors.id] }),
  plan:   one(subscriptionPlans, { fields: [vendorSubscriptions.planId], references: [subscriptionPlans.id] }),
  invoices: many(subscriptionInvoices),
}));
export const subscriptionInvoicesRelations = relations(subscriptionInvoices, ({ one, many }) => ({
  subscription: one(vendorSubscriptions, { fields: [subscriptionInvoices.subscriptionId], references: [vendorSubscriptions.id] }),
  attempts: many(paymentAttempts),
}));
export const paymentAttemptsRelations = relations(paymentAttempts, ({ one }) => ({
  invoice: one(subscriptionInvoices, { fields: [paymentAttempts.invoiceId], references: [subscriptionInvoices.id] }),
}));
