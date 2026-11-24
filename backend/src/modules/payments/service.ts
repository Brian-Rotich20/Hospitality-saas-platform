// Subscription payment processing (Paystack + M-Pesa STK Push).
//
// LinkMart never processes payments for hospitality services: every attempt here is tied
// to a vendor subscription invoice.
//
// Correctness rules:
//  - An attempt row exists before the provider is called; its reference is the attempt id.
//  - Webhooks/callbacks are stored first (provider_events, unique per provider event) and
//    are only a trigger. Credit is granted solely from a server-side verification call.
//  - Status changes happen under a row lock; succeeded is applied once and never undone
//    by a later failure report. A reversed payment is never re-credited.
//  - Amount, currency and reference must match the attempt exactly or nothing is credited.
//  - Anything where money may have moved but could not be applied automatically is
//    flagged `requires_review`. Review is investigative: it never moves money and never
//    changes a vendor's access. Subscription decisions stay in the subscriptions module.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { db, withTransaction, type Db } from '../../platform/database/client.js';
import {
  paymentAttempts, providerEvents, revenueEntries, subscriptionInvoices, vendorSubscriptions,
} from '../../platform/database/schema/subscriptions.js';
import { auditLog } from '../../platform/database/schema/platform.js';
import { vendors } from '../../platform/database/schema/vendors.js';
import { users } from '../../platform/database/schema/users.js';
import { env } from '../../platform/config/env.js';
import { logger } from '../../platform/logger.js';
import { addMinutes } from '../../platform/time.js';
import { subscriptionsService } from '../subscriptions/service.js';
import { enqueueOutbox } from '../notifications/outbox.js';
import { recordAudit } from '../../app/audit.js';
import { AppError, BadGatewayError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../../app/errors.js';
import { createPaystackClient, verifyPaystackSignature, type PaystackClient, type PaystackVerification } from './paystack.adapter.js';
import { createDarajaClient, maskMsisdn, normaliseKenyanMsisdn, STK_RESULT_DESCRIPTIONS, type DarajaClient } from './daraja.adapter.js';

export type AttemptRow = typeof paymentAttempts.$inferSelect;
export type Provider = AttemptRow['provider'];
export type AttemptStatus = AttemptRow['status'];
type ProviderEventRow = typeof providerEvents.$inferSelect;

/** How long a provider event with no matching attempt is retried before it is parked as unmatched. */
export const UNMATCHED_EVENT_RETRY_MINUTES = 60;
/** After this age, an attempt the provider can't confirm is closed (a later provider success still wins). */
const ABANDON_AFTER_MINUTES: Record<Provider, number> = { paystack: 24 * 60, daraja: 60 };

// ── Provider registry (overridable in tests) ─────────────────────────────────
let paystack: PaystackClient | null | undefined;
let daraja: DarajaClient | null | undefined;

function paystackClient(): PaystackClient {
  if (paystack === undefined) {
    paystack = env.PAYSTACK_ENABLED && env.PAYSTACK_SECRET_KEY
      ? createPaystackClient({ secretKey: env.PAYSTACK_SECRET_KEY, baseUrl: env.PAYSTACK_BASE_URL })
      : null;
  }
  if (!paystack) throw new ServiceUnavailableError('Card payments are not available right now', 'PROVIDER_DISABLED');
  return paystack;
}

function darajaClient(): DarajaClient {
  if (daraja === undefined) {
    daraja = env.DARAJA_ENABLED && env.DARAJA_CONSUMER_KEY && env.DARAJA_CONSUMER_SECRET && env.DARAJA_SHORTCODE && env.DARAJA_PASSKEY
      ? createDarajaClient({
        environment: env.DARAJA_ENVIRONMENT, consumerKey: env.DARAJA_CONSUMER_KEY, consumerSecret: env.DARAJA_CONSUMER_SECRET,
        shortcode: env.DARAJA_SHORTCODE, passkey: env.DARAJA_PASSKEY, transactionType: env.DARAJA_TRANSACTION_TYPE, partyB: env.DARAJA_PARTY_B,
      })
      : null;
  }
  if (!daraja) throw new ServiceUnavailableError('M-Pesa payments are not available right now', 'PROVIDER_DISABLED');
  return daraja;
}

export function setPaymentClients(clients: { paystack?: PaystackClient | null; daraja?: DarajaClient | null }): void {
  if ('paystack' in clients) paystack = clients.paystack;
  if ('daraja' in clients) daraja = clients.daraja;
}

export function paymentCapabilities() {
  return {
    paystack: env.PAYSTACK_ENABLED,
    mpesa: env.DARAJA_ENABLED,
    paystackRecurring: env.PAYSTACK_ENABLED && env.PAYSTACK_RECURRING_ENABLED,
    // Daraja has no customer-authorised automatic debit here: each cycle is an STK request.
    mpesaRecurring: false,
  };
}

function darajaCallbackUrl(): string {
  return new URL(`/api/payments/daraja/callback/${env.DARAJA_CALLBACK_TOKEN ?? ''}`, env.API_PUBLIC_URL).toString();
}

const referenceFor = (attemptId: string) => `lm_${attemptId.replace(/-/g, '')}`;

async function lockAttempt(id: string, tx: Db): Promise<AttemptRow | undefined> {
  const [row] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.id, id)).for('update');
  return row;
}

async function updateAttempt(id: string, values: Partial<typeof paymentAttempts.$inferInsert>, tx: Db = db) {
  const [row] = await tx.update(paymentAttempts).set({ ...values, updatedAt: new Date() }).where(eq(paymentAttempts.id, id)).returning();
  return row;
}

/** Flag an attempt for human review. A new flag reopens a previously closed review. */
async function flagReview(attempt: AttemptRow, reason: string, details: Record<string, unknown>, tx: Db) {
  await recordAudit({ actorType: 'provider', action: 'payment.review_required', entityType: 'payment_attempt', entityId: attempt.id, details: { reason, ...details } }, tx);
  return updateAttempt(attempt.id, { requiresReview: true, reviewReason: reason, reviewedAt: null, reviewedBy: null, reviewNote: null }, tx);
}

type Outcome =
  | { kind: 'succeeded'; amountMinor: number; currency: string; receipt: string | null; metadata: Record<string, unknown> }
  | { kind: 'failed'; reason: string; metadata?: Record<string, unknown> }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'reversed' }
  | { kind: 'review'; reason: string; details: Record<string, unknown> }
  | { kind: 'pending' };

/** Apply a verified outcome to an attempt. Idempotent; safe under concurrent delivery. */
async function applyOutcome(attemptId: string, outcome: Outcome, source: string): Promise<AttemptRow | undefined> {
  if (outcome.kind === 'pending') return db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
  if (outcome.kind === 'reversed') return recordReversal(attemptId, { entryType: 'reversal', amountMinor: null, currency: null, source, reason: 'provider_reports_reversed' });
  return withTransaction(async (tx) => {
    const attempt = await lockAttempt(attemptId, tx);
    if (!attempt) throw new NotFoundError('Payment');
    const now = new Date();

    if (outcome.kind === 'review') {
      if (attempt.requiresReview && attempt.reviewReason === outcome.reason && !attempt.reviewedAt) return attempt;
      return flagReview(attempt, outcome.reason, { ...outcome.details, source }, tx);
    }

    if (outcome.kind === 'succeeded') {
      // Duplicate delivery, or a success report for a payment that was since reversed.
      if (attempt.status === 'succeeded' || attempt.status === 'reversed') return attempt;
      if (outcome.amountMinor !== attempt.amountMinor || outcome.currency.toUpperCase() !== attempt.currency) {
        const details = { expectedMinor: attempt.amountMinor, expectedCurrency: attempt.currency, receivedMinor: outcome.amountMinor, receivedCurrency: outcome.currency, source };
        await recordAudit({ actorType: 'provider', action: 'payment.amount_mismatch', entityType: 'payment_attempt', entityId: attempt.id, details }, tx);
        await updateAttempt(attempt.id, { status: 'failed', failureReason: 'amount_or_currency_mismatch_requires_review', verifiedAt: now, completedAt: now }, tx);
        return flagReview({ ...attempt, status: 'failed' }, 'amount_or_currency_mismatch', details, tx);
      }
      // A provider may confirm success after we recorded a failure/timeout: the provider wins.
      const updated = await updateAttempt(attempt.id, {
        status: 'succeeded', providerReceipt: outcome.receipt ?? attempt.providerReceipt, verifiedAt: now, completedAt: now, failureReason: null,
        providerMetadata: { ...(attempt.providerMetadata ?? {}), ...outcome.metadata, verifiedBy: source },
      }, tx);
      const applied = await subscriptionsService.applyInvoicePaid(attempt.invoiceId, attempt.id, tx, now);
      await tx.insert(revenueEntries).values({
        entryType: 'subscription_payment', vendorId: attempt.vendorId, invoiceId: attempt.invoiceId, attemptId: attempt.id,
        amountMinor: attempt.amountMinor, currency: attempt.currency, provider: attempt.provider,
        providerReference: attempt.providerReference, requiresReview: !applied, occurredAt: now,
      }).onConflictDoNothing();
      await recordAudit({ actorType: 'provider', action: 'payment.succeeded', entityType: 'payment_attempt', entityId: attempt.id, details: { source, from: attempt.status } }, tx);
      if (!applied && updated) {
        // Money arrived for an invoice that is no longer open (paid by another attempt, or voided).
        return flagReview(updated, 'paid_settled_invoice', { invoiceId: attempt.invoiceId, source }, tx);
      }
      return updated;
    }

    // failed / cancelled: never downgrade a success, never re-fail a terminal attempt.
    if (attempt.status !== 'initiated' && attempt.status !== 'pending') return attempt;
    const status = outcome.kind === 'failed' ? 'failed' : 'cancelled';
    const updated = await updateAttempt(attempt.id, {
      status, failureReason: outcome.reason, verifiedAt: now, completedAt: now,
      ...(outcome.kind === 'failed' && outcome.metadata ? { providerMetadata: { ...(attempt.providerMetadata ?? {}), ...outcome.metadata } } : {}),
    }, tx);
    await recordAudit({ actorType: 'provider', action: `payment.${status}`, entityType: 'payment_attempt', entityId: attempt.id, details: { reason: outcome.reason, source } }, tx);
    if (attempt.initiatedBy === 'vendor' || attempt.initiatedBy === 'system') {
      await enqueueOutbox(tx, 'subscription.payment_failed', { vendorId: attempt.vendorId, attemptId: attempt.id, amountMinor: attempt.amountMinor, currency: attempt.currency, reason: outcome.reason },
        { dedupeKey: `payment-failed:${attempt.id}` });
    }
    return updated;
  });
}

/**
 * Record a provider reversal or refund of a credited payment: a negative revenue entry and
 * a review flag. The invoice and the vendor's access are deliberately left unchanged:
 * there is no approved refund or reversal policy, so an administrator decides.
 * Idempotent: the journal never records more than the original amount as reversed.
 */
async function recordReversal(attemptId: string, r: { entryType: 'refund' | 'reversal'; amountMinor: number | null; currency: string | null; source: string; reason: string }) {
  return withTransaction(async (tx) => {
    const attempt = await lockAttempt(attemptId, tx);
    if (!attempt) throw new NotFoundError('Payment');
    const now = new Date();
    const details = { entryType: r.entryType, reportedMinor: r.amountMinor, reportedCurrency: r.currency, source: r.source, reason: r.reason };

    if (attempt.status !== 'succeeded' && attempt.status !== 'reversed') {
      // Never credited, so there is nothing to reverse in the journal. Still worth a look.
      if (attempt.status === 'initiated' || attempt.status === 'pending') {
        await updateAttempt(attempt.id, { status: 'failed', failureReason: 'reversed_by_provider', verifiedAt: now, completedAt: now }, tx);
      }
      return flagReview(attempt, 'reversal_of_uncredited_payment', details, tx);
    }
    if (r.currency && r.currency.toUpperCase() !== attempt.currency) {
      return flagReview(attempt, 'reversal_currency_mismatch', details, tx);
    }

    const [prior] = await tx.select({ total: sql<string>`coalesce(sum(-${revenueEntries.amountMinor}), 0)` }).from(revenueEntries)
      .where(and(eq(revenueEntries.attemptId, attempt.id), inArray(revenueEntries.entryType, ['refund', 'reversal'])));
    const alreadyReversed = Number(prior?.total ?? 0);
    const remaining = attempt.amountMinor - alreadyReversed;
    if (remaining <= 0) return attempt; // fully reversed already (duplicate report)
    const requested = r.amountMinor !== null && Number.isInteger(r.amountMinor) && r.amountMinor > 0 ? r.amountMinor : remaining;
    const amount = Math.min(requested, remaining);

    const inserted = await tx.insert(revenueEntries).values({
      entryType: r.entryType, vendorId: attempt.vendorId, invoiceId: attempt.invoiceId, attemptId: attempt.id,
      amountMinor: -amount, currency: attempt.currency, provider: attempt.provider, providerReference: attempt.providerReference,
      requiresReview: true, occurredAt: now,
    }).onConflictDoNothing().returning({ id: revenueEntries.id });
    if (inserted.length === 0) {
      // A second partial refund of the same type: the journal keeps one row per type and
      // attempt, so this one is left for manual reconciliation (the provider event is stored).
      return flagReview(attempt, 'additional_reversal_not_journaled', { ...details, alreadyReversed }, tx);
    }
    const full = alreadyReversed + amount >= attempt.amountMinor;
    await recordAudit({ actorType: 'provider', action: 'payment.reversed', entityType: 'payment_attempt', entityId: attempt.id, details: { ...details, amountMinor: amount, full } }, tx);
    if (full) await updateAttempt(attempt.id, { status: 'reversed', reversedAt: now }, tx);
    return flagReview({ ...attempt, status: full ? 'reversed' : attempt.status }, full ? 'provider_reversal' : 'provider_partial_refund', { ...details, amountMinor: amount }, tx);
  });
}

// ── Verification against providers ───────────────────────────────────────────
function paystackOutcome(attempt: AttemptRow, v: PaystackVerification): Outcome {
  if (v.reference !== attempt.providerReference) {
    return { kind: 'review', reason: 'reference_mismatch', details: { expected: attempt.providerReference, received: v.reference } };
  }
  switch (v.status) {
    case 'success':
      return { kind: 'succeeded', amountMinor: v.amountMinor, currency: v.currency, receipt: v.transactionId,
        metadata: { paystackTransactionId: v.transactionId, channel: v.channel, paidAt: v.paidAt, cardLast4: v.authorization?.last4 ?? null } };
    case 'failed': return { kind: 'failed', reason: v.gatewayResponse ?? 'declined' };
    case 'reversed': return { kind: 'reversed' };
    case 'abandoned': return { kind: 'pending' }; // checkout not completed yet; reconciliation closes it
    default: return { kind: 'pending' };
  }
}

async function verifyWithProvider(attempt: AttemptRow): Promise<{ outcome: Outcome; paystack?: PaystackVerification }> {
  if (!attempt.providerReference) return { outcome: { kind: 'pending' } };
  if (attempt.provider === 'paystack') {
    const v = await paystackClient().verify(attempt.providerReference);
    return { outcome: paystackOutcome(attempt, v), paystack: v };
  }
  const q = await darajaClient().stkQuery(attempt.providerReference);
  if (q.resultCode === null) return { outcome: { kind: 'pending' } };
  if (q.resultCode === '0') {
    // STK Query confirms completion but carries no amount. The amount was fixed by our own
    // request; if the (token-authenticated) callback reported an amount, it must agree.
    const cbKes = attempt.providerMetadata?.callbackAmountKes;
    const amountMinor = typeof cbKes === 'number' ? Math.round(cbKes * 100) : attempt.amountMinor;
    return { outcome: { kind: 'succeeded', amountMinor, currency: attempt.currency,
      receipt: attempt.providerReceipt, metadata: { stkResultCode: q.resultCode } } };
  }
  const reason = STK_RESULT_DESCRIPTIONS[q.resultCode] ?? (q.resultDesc || `M-Pesa result ${q.resultCode}`);
  return { outcome: q.resultCode === '1032' ? { kind: 'cancelled', reason } : { kind: 'failed', reason, metadata: { stkResultCode: q.resultCode } } };
}

/** After a verified Paystack success, remember a reusable card if the vendor opted in. */
async function rememberAuthorization(attempt: AttemptRow, v: PaystackVerification | undefined) {
  if (!v?.authorization?.reusable || !paymentCapabilities().paystackRecurring) return;
  await db.update(vendorSubscriptions)
    .set({ paystackAuthorizationCode: v.authorization.code, paystackCustomerEmail: v.customerEmail, updatedAt: new Date() })
    .where(and(eq(vendorSubscriptions.vendorId, attempt.vendorId), eq(vendorSubscriptions.autoRenewOptIn, true)));
}

export async function verifyAttempt(attempt: AttemptRow, source: string): Promise<AttemptRow | undefined> {
  const { outcome, paystack: v } = await verifyWithProvider(attempt);
  const updated = await applyOutcome(attempt.id, outcome, source);
  if (updated?.status === 'succeeded' && attempt.provider === 'paystack') await rememberAuthorization(attempt, v);
  return updated;
}

// ── Provider payload handling ─────────────────────────────────────────────────
type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** The provider reference an event is about (Paystack reference / Daraja CheckoutRequestID). */
export function eventReference(provider: Provider, payload: unknown): string | null {
  if (provider === 'daraja') return strOrNull(obj(obj(obj(payload)?.Body)?.stkCallback)?.CheckoutRequestID);
  const d = obj(obj(payload)?.data);
  return strOrNull(d?.reference) ?? strOrNull(d?.transaction_reference) ?? strOrNull(obj(d?.transaction)?.reference);
}

/**
 * Strip secrets and personal data before a provider payload is stored: Paystack card
 * authorization codes and signatures; full MSISDNs in M-Pesa callbacks.
 */
export function sanitizeProviderPayload(provider: Provider, payload: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(payload ?? {})) as unknown;
  if (provider === 'paystack') {
    const d = obj(obj(copy)?.data);
    const auth = obj(d?.authorization);
    if (auth) { delete auth.authorization_code; delete auth.signature; }
    const cust = obj(d?.customer);
    if (cust) delete cust.customer_code;
    return copy;
  }
  const items = obj(obj(obj(obj(copy)?.Body)?.stkCallback)?.CallbackMetadata)?.Item;
  if (Array.isArray(items)) {
    for (const it of items) {
      const item = obj(it);
      if (item?.Name === 'PhoneNumber' && (typeof item.Value === 'string' || typeof item.Value === 'number')) item.Value = maskMsisdn(String(item.Value));
    }
  }
  return copy;
}

interface StkItem { Name?: string; Value?: unknown }
function extractStkMetadata(payload: unknown): { receipt: string | null; amountKes: number | null } {
  const raw = obj(obj(obj(obj(payload)?.Body)?.stkCallback)?.CallbackMetadata)?.Item;
  const items: StkItem[] = Array.isArray(raw) ? raw.map((i) => obj(i) ?? {}) : [];
  const receipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;
  const amount = items.find((i) => i.Name === 'Amount')?.Value;
  const amountKes = typeof amount === 'number' ? amount : typeof amount === 'string' && amount.trim() !== '' && Number.isFinite(Number(amount)) ? Number(amount) : null;
  return { receipt: typeof receipt === 'string' ? receipt : null, amountKes };
}

function minorAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function storeEvent(provider: Provider, eventKey: string, eventType: string, payload: unknown): Promise<ProviderEventRow | undefined> {
  const reference = eventReference(provider, payload);
  const attempt = reference
    ? await db.query.paymentAttempts.findFirst({ where: and(eq(paymentAttempts.provider, provider), eq(paymentAttempts.providerReference, reference)), columns: { id: true } })
    : undefined;
  const [stored] = await db.insert(providerEvents).values({
    provider, eventKey: eventKey.slice(0, 200), eventType: eventType.slice(0, 100), signatureValid: true,
    payload: sanitizeProviderPayload(provider, payload), attemptId: attempt?.id ?? null,
  }).onConflictDoNothing().returning();
  return stored;
}

export const paymentsService = {
  /**
   * Start paying the vendor's payable invoice. Idempotent per Idempotency-Key; an
   * in-flight attempt for the same invoice and provider is returned instead of creating a
   * second charge request.
   */
  async initiate(input: { vendorId: string; userId: string; provider: Provider; phone?: string | undefined; idempotencyKey?: string | undefined }) {
    const caps = paymentCapabilities();
    if (input.provider === 'paystack' && !caps.paystack) throw new ServiceUnavailableError('Card payments are not available right now', 'PROVIDER_DISABLED');
    if (input.provider === 'daraja' && !caps.mpesa) throw new ServiceUnavailableError('M-Pesa payments are not available right now', 'PROVIDER_DISABLED');
    const msisdn = input.provider === 'daraja' ? normaliseKenyanMsisdn(input.phone ?? '') : null;
    const key = input.idempotencyKey ?? randomUUID();

    const { attempt, reused } = await withTransaction(async (tx) => {
      const existing = await tx.query.paymentAttempts.findFirst({
        where: and(eq(paymentAttempts.vendorId, input.vendorId), eq(paymentAttempts.idempotencyKey, key)),
      });
      if (existing) {
        if (existing.provider !== input.provider) {
          throw new ConflictError('This Idempotency-Key was already used for a different payment request', 'IDEMPOTENCY_KEY_REUSED');
        }
        return { attempt: existing, reused: true };
      }

      const invoice = await subscriptionsService.payableInvoice(input.vendorId, tx);
      const inFlight = await tx.query.paymentAttempts.findFirst({
        where: and(eq(paymentAttempts.invoiceId, invoice.id), eq(paymentAttempts.provider, input.provider),
          inArray(paymentAttempts.status, ['initiated', 'pending']), sql`${paymentAttempts.createdAt} > now() - interval '3 minutes'`),
      });
      if (inFlight) return { attempt: inFlight, reused: true };

      if (input.provider === 'daraja' && invoice.amountMinor % 100 !== 0) {
        throw new ConflictError('This amount cannot be paid with M-Pesa (not whole shillings)', 'AMOUNT_NOT_SUPPORTED');
      }
      const id = randomUUID();
      const [row] = await tx.insert(paymentAttempts).values({
        id, invoiceId: invoice.id, vendorId: input.vendorId, provider: input.provider, status: 'initiated',
        amountMinor: invoice.amountMinor, currency: invoice.currency, idempotencyKey: key,
        providerReference: input.provider === 'paystack' ? referenceFor(id) : null,
        phoneMasked: msisdn ? maskMsisdn(msisdn) : null, initiatedBy: 'vendor',
      }).returning();
      if (!row) throw new Error('attempt insert returned no row');
      await recordAudit({ actorUserId: input.userId, actorType: 'user', action: 'payment.initiated', entityType: 'payment_attempt', entityId: row.id, details: { provider: input.provider, invoiceId: invoice.id } }, tx);
      return { attempt: row, reused: false };
    });
    if (reused) return attempt;

    try {
      if (input.provider === 'paystack') {
        const owner = await db.select({ email: users.email }).from(vendors).innerJoin(users, eq(users.id, vendors.userId)).where(eq(vendors.id, input.vendorId));
        const email = owner[0]?.email;
        if (!email) throw new NotFoundError('Vendor account email');
        const init = await paystackClient().initialize({
          email, amountMinor: attempt.amountMinor, currency: attempt.currency, reference: attempt.providerReference ?? referenceFor(attempt.id),
          callbackUrl: env.PAYSTACK_CALLBACK_URL, metadata: { attempt_id: attempt.id, invoice_id: attempt.invoiceId, purpose: 'vendor_subscription' },
        });
        return await updateAttempt(attempt.id, { status: 'pending', checkoutUrl: init.authorizationUrl, providerMetadata: { accessCode: init.accessCode } });
      }
      const stk = await darajaClient().stkPush({
        phone: msisdn ?? '', amountKes: attempt.amountMinor / 100, accountReference: `LM${attempt.invoiceId.slice(0, 8)}`,
        description: 'Subscription', callbackUrl: darajaCallbackUrl(),
      });
      return await updateAttempt(attempt.id, {
        status: 'pending', providerReference: stk.checkoutRequestId, providerSecondaryReference: stk.merchantRequestId,
        providerMetadata: { customerMessage: stk.customerMessage },
      });
    } catch (err) {
      // Provider messages can describe our configuration (e.g. "Invalid key"): log them,
      // keep only a stable code on the attempt, and give the vendor a generic message.
      const code = err instanceof AppError ? err.code : 'UNEXPECTED';
      logger.warn({ attemptId: attempt.id, provider: input.provider, code, err: (err as Error).message }, 'payment initiation failed');
      await updateAttempt(attempt.id, { status: 'failed', failureReason: 'initiation_failed', completedAt: new Date(), providerMetadata: { initiationErrorCode: code } });
      if (err instanceof AppError && err.statusCode < 500) throw err;
      throw new BadGatewayError('The payment provider could not start this payment. Please try again shortly.', code === 'UNEXPECTED' ? 'PAYMENT_INITIATION_FAILED' : code);
    }
  },

  /** Vendor polls an attempt; pending attempts are re-verified server-side. */
  async getForVendor(vendorId: string, attemptId: string) {
    const attempt = await db.query.paymentAttempts.findFirst({ where: and(eq(paymentAttempts.id, attemptId), eq(paymentAttempts.vendorId, vendorId)) });
    if (!attempt) throw new NotFoundError('Payment');
    if (attempt.status === 'pending' && Date.now() - attempt.updatedAt.getTime() > 5_000) {
      try {
        return (await verifyAttempt(attempt, 'vendor_poll')) ?? attempt;
      } catch (err) {
        logger.warn({ attemptId, err: (err as Error).message }, 'verification during poll failed');
      }
    }
    return attempt;
  },

  // ── Paystack webhook ─────────────────────────────────────────────────────────
  async handlePaystackWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ accepted: boolean; duplicate?: boolean }> {
    if (!env.PAYSTACK_SECRET_KEY || !verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY)) {
      logger.warn('paystack webhook rejected: invalid signature');
      return { accepted: false };
    }
    let event: unknown;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { accepted: false };
    }
    const type = strOrNull(obj(event)?.event) ?? 'unknown';
    const data = obj(obj(event)?.data);
    const id = data?.id;
    const eventKey = `${type}:${eventReference('paystack', event) ?? ''}:${typeof id === 'string' || typeof id === 'number' ? String(id) : ''}`;
    const stored = await storeEvent('paystack', eventKey, type, event);
    if (!stored) return { accepted: true, duplicate: true };
    await this.processStoredEvent(stored.id);
    return { accepted: true };
  },

  // ── Daraja STK callback ──────────────────────────────────────────────────────
  async handleDarajaCallback(token: string, ip: string, body: unknown): Promise<{ accepted: boolean; duplicate?: boolean }> {
    const expected = env.DARAJA_CALLBACK_TOKEN ?? '';
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) return { accepted: false };
    if (env.DARAJA_ALLOWED_IPS?.length && !env.DARAJA_ALLOWED_IPS.includes(ip)) {
      logger.warn({ ip }, 'daraja callback from non-allow-listed IP rejected');
      return { accepted: false };
    }
    const cb = obj(obj(obj(body)?.Body)?.stkCallback);
    const checkoutId = strOrNull(cb?.CheckoutRequestID);
    if (!checkoutId) throw new ValidationError('Malformed STK callback');
    const rc = cb?.ResultCode;
    const eventKey = `${checkoutId}:${typeof rc === 'string' || typeof rc === 'number' ? String(rc) : ''}`;
    const stored = await storeEvent('daraja', eventKey, 'stk_callback', body);
    if (!stored) return { accepted: true, duplicate: true };
    await this.processStoredEvent(stored.id);
    return { accepted: true };
  },

  /**
   * Process a stored provider event. Always re-verifies with the provider before crediting.
   * Events whose attempt isn't known yet (a callback racing the initiation response) are
   * retried by reconciliation for UNMATCHED_EVENT_RETRY_MINUTES, then parked as unmatched
   * for an administrator. Never throws: failures are recorded on the event row.
   */
  async processStoredEvent(eventId: string): Promise<void> {
    const ev = await db.query.providerEvents.findFirst({ where: eq(providerEvents.id, eventId) });
    if (!ev || ev.processedAt) return;
    const finish = (lastError: string | null) => db.update(providerEvents)
      .set({ processedAt: new Date(), processingAttempts: sql`${providerEvents.processingAttempts} + 1`, lastError })
      .where(eq(providerEvents.id, eventId));
    try {
      let attemptId = ev.attemptId;
      if (!attemptId) {
        const ref = eventReference(ev.provider, ev.payload);
        const match = ref ? await db.query.paymentAttempts.findFirst({ where: and(eq(paymentAttempts.provider, ev.provider), eq(paymentAttempts.providerReference, ref)), columns: { id: true } }) : undefined;
        if (match) {
          attemptId = match.id;
          await db.update(providerEvents).set({ attemptId }).where(eq(providerEvents.id, eventId));
        } else {
          const ageMin = (Date.now() - ev.receivedAt.getTime()) / 60_000;
          if (ref && ageMin < UNMATCHED_EVENT_RETRY_MINUTES) throw new Error('no matching payment attempt yet');
          await finish('unmatched: no payment attempt has this provider reference');
          await recordAudit({ actorType: 'provider', action: 'payment.unmatched_provider_event', entityType: 'provider_event', entityId: ev.id, details: { provider: ev.provider, eventType: ev.eventType, reference: ref } });
          return;
        }
      }
      const attempt = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
      if (!attempt) { await finish('attempt missing'); return; }

      if (ev.provider === 'daraja') {
        const meta = extractStkMetadata(ev.payload);
        const patch: Partial<typeof paymentAttempts.$inferInsert> = {};
        if (meta.receipt && !attempt.providerReceipt) patch.providerReceipt = meta.receipt;
        if (meta.amountKes !== null && attempt.providerMetadata?.callbackAmountKes === undefined) {
          patch.providerMetadata = { ...(attempt.providerMetadata ?? {}), callbackAmountKes: meta.amountKes };
        }
        const fresh = Object.keys(patch).length ? (await updateAttempt(attempt.id, patch)) ?? attempt : attempt;
        await verifyAttempt(fresh, 'daraja_callback');
      } else {
        const data = obj(obj(ev.payload)?.data);
        switch (ev.eventType) {
          case 'charge.success':
            await verifyAttempt(attempt, 'paystack_webhook');
            break;
          case 'refund.processed':
            // HMAC-authenticated report from Paystack; it removes revenue, never grants access.
            await recordReversal(attempt.id, { entryType: 'refund', amountMinor: minorAmount(data?.amount), currency: strOrNull(data?.currency), source: 'paystack_webhook', reason: 'refund.processed' });
            break;
          case 'charge.dispute.create':
          case 'charge.dispute.remind':
          case 'charge.dispute.resolve':
            await applyOutcome(attempt.id, { kind: 'review', reason: 'provider_dispute', details: { eventType: ev.eventType, disputeStatus: strOrNull(data?.status), resolution: strOrNull(data?.resolution) } }, 'paystack_webhook');
            break;
          default:
            break; // stored for the record; no action
        }
      }
      await finish(null);
    } catch (err) {
      // Left unprocessed: the reconciliation job retries it (bounded by processing_attempts).
      await db.update(providerEvents).set({ processingAttempts: sql`${providerEvents.processingAttempts} + 1`, lastError: (err as Error).message.slice(0, 500) }).where(eq(providerEvents.id, eventId));
      logger.warn({ eventId, err: (err as Error).message }, 'provider event processing failed; will retry');
    }
  },

  /**
   * Reconciliation: fail attempts that never reached the provider, re-verify stale pending
   * attempts (covers missed webhooks/callbacks), close abandoned ones, and retry
   * unprocessed provider events. Each item is isolated: one failure never stops the run.
   */
  async reconcilePending(now = new Date()): Promise<{ verified: number; closed: number; eventsRetried: number; errors: number }> {
    let verified = 0; let closed = 0; let eventsRetried = 0; let errors = 0;
    const cutoff = addMinutes(now, -env.PAYMENT_PENDING_RECONCILE_MINUTES);
    const ageMinutes = (a: AttemptRow) => (now.getTime() - a.createdAt.getTime()) / 60_000;

    const stale = await db.select().from(paymentAttempts)
      .where(and(inArray(paymentAttempts.status, ['pending', 'initiated']), lte(paymentAttempts.updatedAt, cutoff)))
      .orderBy(paymentAttempts.updatedAt).limit(200);
    for (const a of stale) {
      try {
        if (!a.providerReference) {
          // Process died between the insert and the provider call: nothing to verify.
          await applyOutcome(a.id, { kind: 'failed', reason: 'initiation_incomplete' }, 'reconcile');
          closed++;
          continue;
        }
        let res: AttemptRow | undefined;
        try {
          res = await verifyAttempt(a, 'reconcile');
          verified++;
        } catch (err) {
          errors++;
          logger.warn({ attemptId: a.id, err: (err as Error).message }, 'reconciliation verify failed');
          // Unverifiable for longer than the provider keeps it open: close it. A later
          // provider success still credits it (the provider wins), so nothing is lost.
          if (ageMinutes(a) > 2 * ABANDON_AFTER_MINUTES[a.provider]) {
            await applyOutcome(a.id, { kind: 'cancelled', reason: 'unverifiable_timed_out' }, 'reconcile');
            closed++;
          }
          continue;
        }
        if (res && (res.status === 'pending' || res.status === 'initiated') && ageMinutes(a) > ABANDON_AFTER_MINUTES[a.provider]) {
          await applyOutcome(a.id, { kind: 'cancelled', reason: 'abandoned_or_timed_out' }, 'reconcile');
          closed++;
        }
      } catch (err) {
        errors++;
        logger.error({ attemptId: a.id, err: (err as Error).message }, 'reconciliation step failed');
      }
    }

    const events = await db.select({ id: providerEvents.id }).from(providerEvents)
      .where(and(isNull(providerEvents.processedAt), sql`${providerEvents.processingAttempts} < 10`))
      .orderBy(providerEvents.receivedAt).limit(200);
    for (const e of events) { await this.processStoredEvent(e.id); eventsRetried++; }
    return { verified, closed, eventsRetried, errors };
  },

  /**
   * Saved-card renewals for vendors who opted in (Paystack reusable authorizations only).
   * Run after the lifecycle tick has issued invoices. Disabled unless
   * PAYSTACK_RECURRING_ENABLED=true (awaiting business approval, D4).
   */
  async chargeDueAutoRenewals(): Promise<number> {
    if (!paymentCapabilities().paystackRecurring) return 0;
    const due = await db.select({ sub: vendorSubscriptions, inv: subscriptionInvoices }).from(vendorSubscriptions)
      .innerJoin(subscriptionInvoices, and(eq(subscriptionInvoices.subscriptionId, vendorSubscriptions.id), eq(subscriptionInvoices.status, 'open')))
      .where(and(eq(vendorSubscriptions.autoRenewOptIn, true), sql`${vendorSubscriptions.paystackAuthorizationCode} is not null`)).limit(200);
    let charged = 0;
    for (const { sub, inv } of due) {
      const key = `auto-renew:${inv.id}`;
      const exists = await db.query.paymentAttempts.findFirst({ where: and(eq(paymentAttempts.vendorId, sub.vendorId), eq(paymentAttempts.idempotencyKey, key)) });
      if (exists) continue;
      const id = randomUUID();
      const [attempt] = await db.insert(paymentAttempts).values({
        id, invoiceId: inv.id, vendorId: sub.vendorId, provider: 'paystack', status: 'initiated', amountMinor: inv.amountMinor,
        currency: inv.currency, idempotencyKey: key, providerReference: referenceFor(id), initiatedBy: 'system',
      }).onConflictDoNothing().returning();
      if (!attempt) continue;
      try {
        await paystackClient().chargeAuthorization({
          authorizationCode: sub.paystackAuthorizationCode ?? '', email: sub.paystackCustomerEmail ?? '',
          amountMinor: inv.amountMinor, currency: inv.currency, reference: attempt.providerReference ?? referenceFor(id),
          metadata: { attempt_id: id, invoice_id: inv.id, purpose: 'vendor_subscription_renewal' },
        });
        await updateAttempt(id, { status: 'pending' });
        // Credit only after an independent verify call, same as every other path.
        await verifyAttempt({ ...attempt, status: 'pending' }, 'auto_renew');
        charged++;
      } catch (err) {
        const code = err instanceof AppError ? err.code : 'UNEXPECTED';
        logger.warn({ attemptId: id, code, err: (err as Error).message }, 'auto-renewal charge failed');
        await applyOutcome(id, { kind: 'failed', reason: `auto_renew_failed:${code}` }, 'auto_renew');
      }
    }
    return charged;
  },

  // ── Administration (investigation only: no money movement, no access changes) ──
  async listForAdmin(f: { status?: AttemptStatus | undefined; provider?: Provider | undefined; vendorId?: string | undefined; needsReview?: boolean | undefined; limit: number; offset: number }) {
    const conds: SQL[] = [];
    if (f.status) conds.push(eq(paymentAttempts.status, f.status));
    if (f.provider) conds.push(eq(paymentAttempts.provider, f.provider));
    if (f.vendorId) conds.push(eq(paymentAttempts.vendorId, f.vendorId));
    if (f.needsReview === true) conds.push(eq(paymentAttempts.requiresReview, true), isNull(paymentAttempts.reviewedAt));
    return db.select({
      id: paymentAttempts.id, vendorId: paymentAttempts.vendorId, businessName: vendors.businessName, invoiceId: paymentAttempts.invoiceId,
      provider: paymentAttempts.provider, status: paymentAttempts.status, amountMinor: paymentAttempts.amountMinor, currency: paymentAttempts.currency,
      providerReference: paymentAttempts.providerReference, providerReceipt: paymentAttempts.providerReceipt, failureReason: paymentAttempts.failureReason,
      requiresReview: paymentAttempts.requiresReview, reviewReason: paymentAttempts.reviewReason, reviewedAt: paymentAttempts.reviewedAt,
      initiatedBy: paymentAttempts.initiatedBy, createdAt: paymentAttempts.createdAt, completedAt: paymentAttempts.completedAt, reversedAt: paymentAttempts.reversedAt,
    }).from(paymentAttempts).innerJoin(vendors, eq(vendors.id, paymentAttempts.vendorId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(paymentAttempts.createdAt)).limit(f.limit).offset(f.offset);
  },

  async getForAdmin(attemptId: string) {
    const attempt = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
    if (!attempt) throw new NotFoundError('Payment');
    const [invoice, events, journal, audit] = await Promise.all([
      db.query.subscriptionInvoices.findFirst({ where: eq(subscriptionInvoices.id, attempt.invoiceId) }),
      db.select().from(providerEvents).where(eq(providerEvents.attemptId, attempt.id)).orderBy(providerEvents.receivedAt),
      db.select().from(revenueEntries).where(eq(revenueEntries.attemptId, attempt.id)).orderBy(revenueEntries.createdAt),
      db.select().from(auditLog).where(and(eq(auditLog.entityType, 'payment_attempt'), eq(auditLog.entityId, attempt.id))).orderBy(auditLog.createdAt),
    ]);
    return { attempt: { ...attempt, checkoutUrl: undefined }, invoice: invoice ?? null, providerEvents: events, revenueEntries: journal, auditTrail: audit };
  },

  /** Close a review with a note. Investigative bookkeeping only. */
  async markReviewed(attemptId: string, adminUserId: string, note: string, requestId?: string) {
    return withTransaction(async (tx) => {
      const attempt = await lockAttempt(attemptId, tx);
      if (!attempt) throw new NotFoundError('Payment');
      if (!attempt.requiresReview || attempt.reviewedAt) throw new ConflictError('This payment has no open review', 'NO_OPEN_REVIEW');
      const updated = await updateAttempt(attempt.id, { reviewedAt: new Date(), reviewedBy: adminUserId, reviewNote: note }, tx);
      await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: 'payment.reviewed', entityType: 'payment_attempt', entityId: attempt.id, details: { reason: attempt.reviewReason, note }, requestId }, tx);
      return updated;
    });
  },

  /** Ask the provider again. Only the provider's answer is applied (same rules as every other path). */
  async reverifyForAdmin(attemptId: string, adminUserId: string, requestId?: string) {
    const attempt = await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attemptId) });
    if (!attempt) throw new NotFoundError('Payment');
    // Any status: applyOutcome never re-credits a reversed payment or downgrades a success.
    if (!attempt.providerReference) throw new ConflictError('This payment never reached the provider', 'NOT_VERIFIABLE');
    await recordAudit({ actorUserId: adminUserId, actorType: 'admin', action: 'payment.admin_reverify', entityType: 'payment_attempt', entityId: attempt.id, details: { from: attempt.status }, requestId });
    return (await verifyAttempt(attempt, 'admin_reverify')) ?? attempt;
  },

  /** Provider events: unmatched (no attempt), or not yet processed (stuck / retrying). */
  listProviderEvents(f: { state?: 'unmatched' | 'unprocessed' | undefined; provider?: Provider | undefined; limit: number; offset: number }) {
    const conds: SQL[] = [];
    if (f.state === 'unmatched') conds.push(isNull(providerEvents.attemptId));
    if (f.state === 'unprocessed') conds.push(isNull(providerEvents.processedAt));
    if (f.provider) conds.push(eq(providerEvents.provider, f.provider));
    return db.select().from(providerEvents).where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(providerEvents.receivedAt)).limit(f.limit).offset(f.offset);
  },
};
