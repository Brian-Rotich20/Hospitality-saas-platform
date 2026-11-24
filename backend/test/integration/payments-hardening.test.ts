// Phase 4: subscription payment hardening. Reversals, review flags, mismatches, unmatched
// and racing provider events, payload sanitisation, reconciliation of unverifiable
// attempts, and the admin investigation API. Real Postgres/Redis; providers are fakes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { call, db, endTrial, json, makeAdmin, makeCustomer, makeVendor, type Actor } from '../helpers/app.js';
import { FakeDaraja, FakePaystack, paystackEvent, stkCallback } from '../helpers/fake-providers.js';
import { paymentsService, setPaymentClients } from '../../src/modules/payments/service.js';
import { subscriptionsService } from '../../src/modules/subscriptions/service.js';
import { paymentAttempts, providerEvents, revenueEntries, subscriptionInvoices, vendorSubscriptions } from '../../src/platform/database/schema/subscriptions.js';

const PRICE = 150000;
const TOKEN = 'cb_test_token_0123456789abcdef';
const paystack = new FakePaystack();
const daraja = new FakeDaraja();
let admin: Actor;

type Vendor = Actor & { vendorId: string };
interface AttemptView { id: string; reference: string; status: string }

async function dueVendor(name: string): Promise<Vendor> {
  const v = await makeVendor(name);
  await endTrial(v.vendorId);
  await subscriptionsService.runLifecycle();
  return v;
}

async function pay(v: Vendor, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<AttemptView> {
  const res = await call('POST', '/api/subscriptions/me/payments', { actor: v, body, headers });
  if (res.statusCode !== 202) throw new Error(`initiate failed ${res.statusCode}: ${res.body}`);
  return json(res).data as AttemptView;
}

async function paidByCard(v: Vendor): Promise<AttemptView> {
  const a = await pay(v, { provider: 'paystack' });
  paystack.succeed(a.reference, PRICE);
  await call('POST', '/api/payments/paystack/webhook', paystackEvent('charge.success', { id: randomUUID(), reference: a.reference }));
  return a;
}

const attemptRow = async (id: string) => (await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, id) }))!;
const subOf = async (vendorId: string) => (await db.query.vendorSubscriptions.findFirst({ where: eq(vendorSubscriptions.vendorId, vendorId) }))!;
const journal = (attemptId: string) => db.select().from(revenueEntries).where(eq(revenueEntries.attemptId, attemptId));
const reversedTotal = async (attemptId: string) => (await journal(attemptId)).filter((e) => e.amountMinor < 0).reduce((s, e) => s + e.amountMinor, 0);

beforeAll(async () => {
  setPaymentClients({ paystack, daraja });
  admin = await makeAdmin();
  const res = await call('POST', '/api/admin/subscriptions/plans', { actor: admin, body: { code: `hardening-${randomUUID().slice(0, 8)}`, name: 'Monthly', amountMinor: PRICE, currency: 'KES', activate: true } });
  expect(res.statusCode).toBe(201);
});

afterAll(() => setPaymentClients({ paystack: undefined as never, daraja: undefined as never }));

describe('Paystack reversals and refunds (recorded, flagged, never auto-applied to access)', () => {
  let v: Vendor;
  let a: AttemptView;

  it('a full refund journals a negative entry, marks the payment reversed and flags it; access is unchanged', async () => {
    v = await dueVendor('Refund Co');
    a = await paidByCard(v);
    expect((await attemptRow(a.id)).status).toBe('succeeded');

    const refund = paystackEvent('refund.processed', { id: 'rf_full_1', transaction_reference: a.reference, amount: PRICE, currency: 'KES', status: 'processed' });
    expect((await call('POST', '/api/payments/paystack/webhook', refund)).statusCode).toBe(200);

    const row = await attemptRow(a.id);
    expect(row).toMatchObject({ status: 'reversed', requiresReview: true, reviewReason: 'provider_reversal' });
    expect(row.reversedAt).toBeTruthy();
    expect(await reversedTotal(a.id)).toBe(-PRICE);
    // No approved refund policy: subscription and invoice are left for an administrator.
    expect((await subOf(v.vendorId)).status).toBe('active');
    const inv = await db.query.subscriptionInvoices.findFirst({ where: eq(subscriptionInvoices.paidByAttemptId, a.id) });
    expect(inv?.status).toBe('paid');
  });

  it('duplicate and repeated reversal reports never reverse more than was paid', async () => {
    const refund = paystackEvent('refund.processed', { id: 'rf_full_1', transaction_reference: a.reference, amount: PRICE, currency: 'KES', status: 'processed' });
    expect(json(await call('POST', '/api/payments/paystack/webhook', refund)).duplicate).toBe(true);
    // A distinct event for the same refund, then the provider's own status says reversed.
    await call('POST', '/api/payments/paystack/webhook', paystackEvent('refund.processed', { id: 'rf_full_2', transaction_reference: a.reference, amount: PRICE, currency: 'KES' }));
    paystack.reverse(a.reference);
    expect((await call('POST', `/api/admin/payments/${a.id}/reverify`, { actor: admin })).statusCode).toBe(200);
    expect(await reversedTotal(a.id)).toBe(-PRICE);
  });

  it('a reversed payment is never re-credited by a later success report', async () => {
    paystack.succeed(a.reference, PRICE);
    await call('POST', `/api/admin/payments/${a.id}/reverify`, { actor: admin });
    expect((await attemptRow(a.id)).status).toBe('reversed');
    expect((await journal(a.id)).filter((e) => e.entryType === 'subscription_payment')).toHaveLength(1);
  });

  it('a partial refund keeps the payment succeeded; a later full reversal journals only the remainder', async () => {
    const w = await dueVendor('Partial Refund Co');
    const p = await paidByCard(w);
    await call('POST', '/api/payments/paystack/webhook', paystackEvent('refund.processed', { id: 'rf_part_1', transaction_reference: p.reference, amount: 50000, currency: 'KES' }));
    expect(await attemptRow(p.id)).toMatchObject({ status: 'succeeded', requiresReview: true, reviewReason: 'provider_partial_refund' });
    expect(await reversedTotal(p.id)).toBe(-50000);

    // Second partial refund: the journal keeps one refund row per payment, so it is parked for review.
    await call('POST', '/api/payments/paystack/webhook', paystackEvent('refund.processed', { id: 'rf_part_2', transaction_reference: p.reference, amount: 20000, currency: 'KES' }));
    expect((await attemptRow(p.id)).reviewReason).toBe('additional_reversal_not_journaled');
    expect(await reversedTotal(p.id)).toBe(-50000);

    paystack.reverse(p.reference);
    await paymentsService.reverifyForAdmin(p.id, admin.userId);
    expect((await attemptRow(p.id)).status).toBe('reversed');
    expect(await reversedTotal(p.id)).toBe(-PRICE);
  });

  it('a dispute flags the payment for review without touching the journal', async () => {
    const w = await dueVendor('Dispute Co');
    const p = await paidByCard(w);
    await call('POST', '/api/payments/paystack/webhook', paystackEvent('charge.dispute.create', { id: 'dsp_1', transaction: { reference: p.reference }, status: 'awaiting-merchant-feedback' }));
    expect(await attemptRow(p.id)).toMatchObject({ status: 'succeeded', requiresReview: true, reviewReason: 'provider_dispute' });
    expect(await reversedTotal(p.id)).toBe(0);
  });
});

describe('verification mismatches are never credited', () => {
  it('Paystack verification for a different reference is flagged and not credited', async () => {
    const v = await dueVendor('Ref Mismatch Co');
    const a = await pay(v, { provider: 'paystack' });
    paystack.succeed(a.reference, PRICE, { reference: 'lm_someone_else' });
    await call('POST', '/api/payments/paystack/webhook', paystackEvent('charge.success', { id: randomUUID(), reference: a.reference }));
    expect(await attemptRow(a.id)).toMatchObject({ status: 'pending', requiresReview: true, reviewReason: 'reference_mismatch' });
    expect((await subOf(v.vendorId)).status).toBe('past_due');
    expect(await journal(a.id)).toHaveLength(0);
  });

  it('an M-Pesa callback reporting a different amount blocks the credit even when STK Query says success', async () => {
    const v = await dueVendor('STK Amount Co');
    const a = await pay(v, { provider: 'mpesa', phone: '0712345678' });
    const checkoutId = daraja.pushes.at(-1)!.checkoutRequestId;
    daraja.queryResults.set(checkoutId, { resultCode: '0', resultDesc: 'Success' });
    expect((await call('POST', `/api/payments/daraja/callback/${TOKEN}`, { body: stkCallback(checkoutId, 0, 1) })).statusCode).toBe(200);
    expect(await attemptRow(a.id)).toMatchObject({ status: 'failed', requiresReview: true, reviewReason: 'amount_or_currency_mismatch' });
    expect((await subOf(v.vendorId)).status).toBe('past_due');

    // Stored callback payloads never keep the full phone number.
    const [ev] = await db.select().from(providerEvents).where(eq(providerEvents.attemptId, a.id));
    expect(JSON.stringify(ev!.payload)).toContain('254******678');
    expect(JSON.stringify(ev!.payload)).not.toContain('254712345678');
  });

  it('a second successful payment for an already-paid invoice is recorded and flagged, never applied twice', async () => {
    const v = await dueVendor('Double Pay Co');
    const card = await pay(v, { provider: 'paystack' });
    const stk = await pay(v, { provider: 'mpesa', phone: '0712345678' });
    const checkoutId = daraja.pushes.at(-1)!.checkoutRequestId;

    paystack.succeed(card.reference, PRICE);
    await call('POST', '/api/payments/paystack/webhook', paystackEvent('charge.success', { id: randomUUID(), reference: card.reference }));
    const periodEnd = (await subOf(v.vendorId)).currentPeriodEnd;

    daraja.queryResults.set(checkoutId, { resultCode: '0', resultDesc: 'Success' });
    await call('POST', `/api/payments/daraja/callback/${TOKEN}`, { body: stkCallback(checkoutId, 0, 1500, 'SGHDOUBLE1') });

    expect(await attemptRow(stk.id)).toMatchObject({ status: 'succeeded', requiresReview: true, reviewReason: 'paid_settled_invoice' });
    const [entry] = await journal(stk.id);
    expect(entry).toMatchObject({ entryType: 'subscription_payment', requiresReview: true });
    // The subscription period was extended once, not twice.
    expect((await subOf(v.vendorId)).currentPeriodEnd?.getTime()).toBe(periodEnd?.getTime());
  });
});

describe('initiation safety', () => {
  it('reusing an Idempotency-Key for a different provider is rejected', async () => {
    const v = await dueVendor('Idem Co');
    const key = `idem-${randomUUID()}`;
    await pay(v, { provider: 'paystack' }, { 'idempotency-key': key });
    const res = await call('POST', '/api/subscriptions/me/payments', { actor: v, body: { provider: 'mpesa', phone: '0712345678' }, headers: { 'idempotency-key': key } });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a provider rejection is reported generically: no provider or configuration detail reaches the vendor', async () => {
    const v = await dueVendor('Init Fail Co');
    paystack.failNextInitialize = 'Invalid key sk_live_something';
    const res = await call('POST', '/api/subscriptions/me/payments', { actor: v, body: { provider: 'paystack' } });
    expect(res.statusCode).toBe(502);
    expect(json(res).code).toBe('PAYSTACK_REJECTED');
    expect(res.body).not.toMatch(/Invalid key|sk_live/);
    const [row] = await db.select().from(paymentAttempts).where(eq(paymentAttempts.vendorId, v.vendorId));
    expect(row).toMatchObject({ status: 'failed', failureReason: 'initiation_failed' });
    const list = await call('GET', '/api/subscriptions/me/payments', { actor: v });
    expect(list.body).not.toMatch(/Invalid key|sk_live/);
  });

  it('Paystack webhook payloads are stored without card authorization codes or signatures', async () => {
    const v = await dueVendor('Sanitise Co');
    const a = await pay(v, { provider: 'paystack' });
    paystack.succeed(a.reference, PRICE);
    await call('POST', '/api/payments/paystack/webhook', paystackEvent('charge.success', {
      id: randomUUID(), reference: a.reference, authorization: { authorization_code: 'AUTH_secret_code', signature: 'SIG_secret', last4: '4081', reusable: true },
    }));
    const [ev] = await db.select().from(providerEvents).where(eq(providerEvents.attemptId, a.id));
    const stored = JSON.stringify(ev!.payload);
    expect(stored).not.toContain('AUTH_secret_code');
    expect(stored).not.toContain('SIG_secret');
    expect(stored).toContain('4081');
  });
});

describe('delayed, early and missing provider messages', () => {
  it('a callback that arrives before its attempt is linked is retried and then applied', async () => {
    const early = `ws_CO_early_${randomUUID()}`;
    expect((await call('POST', `/api/payments/daraja/callback/${TOKEN}`, { body: stkCallback(early, 0, 1500, 'SGHEARLY01') })).statusCode).toBe(200);
    const [ev] = await db.select().from(providerEvents).where(and(eq(providerEvents.provider, 'daraja'), eq(providerEvents.eventKey, `${early}:0`)));
    expect(ev).toMatchObject({ attemptId: null, processedAt: null, lastError: 'no matching payment attempt yet' });

    // The initiation response is recorded after the callback (the race being simulated).
    const v = await dueVendor('Early Callback Co');
    const a = await pay(v, { provider: 'mpesa', phone: '0712345678' });
    await db.update(paymentAttempts).set({ providerReference: early }).where(eq(paymentAttempts.id, a.id));
    daraja.queryResults.set(early, { resultCode: '0', resultDesc: 'Success' });

    await paymentsService.reconcilePending();
    expect(await attemptRow(a.id)).toMatchObject({ status: 'succeeded', providerReceipt: 'SGHEARLY01' });
    expect((await db.query.providerEvents.findFirst({ where: eq(providerEvents.id, ev!.id) }))).toMatchObject({ attemptId: a.id, lastError: null });
    expect((await subOf(v.vendorId)).status).toBe('active');
  });

  it('a provider event that never matches is parked as unmatched and listed for admins', async () => {
    const orphan = `ws_CO_orphan_${randomUUID()}`;
    await call('POST', `/api/payments/daraja/callback/${TOKEN}`, { body: stkCallback(orphan, 0, 1500) });
    await db.update(providerEvents).set({ receivedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(providerEvents.eventKey, `${orphan}:0`));
    await paymentsService.reconcilePending();
    const ev = await db.query.providerEvents.findFirst({ where: eq(providerEvents.eventKey, `${orphan}:0`) });
    expect(ev?.processedAt).toBeTruthy();
    expect(ev?.lastError).toMatch(/^unmatched/);
    const list = json(await call('GET', '/api/admin/payments/provider-events?state=unmatched&limit=100', { actor: admin })).data as { id: string }[];
    expect(list.some((e) => e.id === ev!.id)).toBe(true);
  });

  it('an attempt the provider cannot confirm is eventually closed; a later verified success still credits it', async () => {
    const v = await dueVendor('Unverifiable Co');
    const a = await pay(v, { provider: 'paystack' });
    paystack.verifyErrors.add(a.reference);
    const old = new Date(Date.now() - 3 * 86_400_000);
    await db.update(paymentAttempts).set({ createdAt: old, updatedAt: old }).where(eq(paymentAttempts.id, a.id));
    await paymentsService.reconcilePending();
    expect(await attemptRow(a.id)).toMatchObject({ status: 'cancelled', failureReason: 'unverifiable_timed_out' });

    paystack.verifyErrors.delete(a.reference);
    paystack.succeed(a.reference, PRICE);
    await call('POST', '/api/payments/paystack/webhook', paystackEvent('charge.success', { id: randomUUID(), reference: a.reference }));
    expect((await attemptRow(a.id)).status).toBe('succeeded');
    expect((await subOf(v.vendorId)).status).toBe('active');
  });

  it('reconciliation is idempotent: a second run changes nothing', async () => {
    const before = await db.select({ id: paymentAttempts.id, status: paymentAttempts.status }).from(paymentAttempts);
    await paymentsService.reconcilePending();
    const after = await db.select({ id: paymentAttempts.id, status: paymentAttempts.status }).from(paymentAttempts);
    const byId = new Map(before.map((r) => [r.id, r.status]));
    expect(after.filter((r) => byId.get(r.id) !== r.status)).toHaveLength(0);
  });
});

describe('admin payment investigation', () => {
  it('is admin-only', async () => {
    expect((await call('GET', '/api/admin/payments')).statusCode).toBe(401);
    expect((await call('GET', '/api/admin/payments', { actor: await makeCustomer() })).statusCode).toBe(403);
    expect((await call('GET', '/api/admin/payments', { actor: await makeVendor('Nosy Vendor') })).statusCode).toBe(403);
  });

  it('lists the review queue, shows the full trail, and closes a review with a note (no money or access change)', async () => {
    const queue = json(await call('GET', '/api/admin/payments?needsReview=true&limit=100', { actor: admin })).data as { id: string; requiresReview: boolean; reviewedAt: string | null }[];
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((q) => q.requiresReview && q.reviewedAt === null)).toBe(true);
    const target = queue[0]!;
    const before = await attemptRow(target.id);

    const detail = await call('GET', `/api/admin/payments/${target.id}`, { actor: admin });
    expect(detail.statusCode).toBe(200);
    const d = json(detail).data;
    expect(d.attempt.checkoutUrl).toBeUndefined();
    expect(Array.isArray(d.auditTrail)).toBe(true);
    expect(d.auditTrail.some((x: { action: string }) => x.action === 'payment.review_required')).toBe(true);

    const closed = await call('POST', `/api/admin/payments/${target.id}/review`, { actor: admin, body: { note: 'Checked with the provider dashboard.' } });
    expect(closed.statusCode).toBe(200);
    const after = await attemptRow(target.id);
    expect(after.reviewedAt).toBeTruthy();
    expect(after.reviewedBy).toBe(admin.userId);
    expect(after.status).toBe(before.status);
    const again = await call('POST', `/api/admin/payments/${target.id}/review`, { actor: admin, body: { note: 'Second time.' } });
    expect(again.statusCode).toBe(409);
    expect(json(again).code).toBe('NO_OPEN_REVIEW');
  });

  it('filters by provider using the public provider names', async () => {
    const rows = json(await call('GET', '/api/admin/payments?provider=mpesa&limit=100', { actor: admin })).data as { provider: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.provider === 'daraja')).toBe(true);
  });

  it('the per-vendor subscription view never returns a stored card authorization', async () => {
    const v = await dueVendor('Saved Card Co');
    await db.update(vendorSubscriptions).set({ paystackAuthorizationCode: 'AUTH_stored_secret' }).where(eq(vendorSubscriptions.vendorId, v.vendorId));
    const res = await call('GET', `/api/admin/subscriptions/vendors/${v.vendorId}`, { actor: admin });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('AUTH_stored_secret');
    expect(json(res).data.subscription.hasSavedCard).toBe(true);
    expect((await call('GET', `/api/admin/subscriptions/vendors/${randomUUID()}`, { actor: admin })).statusCode).toBe(404);
  });

  it('the admin vendor view says whether payout details exist but never shows them', async () => {
    const v = await makeVendor('Payout Private Co');
    expect((await call('POST', '/api/vendors/me/payout-details', { actor: v, body: { payoutMethod: 'mpesa', mpesaNumber: '0711222333' } })).statusCode).toBe(200);
    const res = await call('GET', `/api/admin/vendors/${v.vendorId}`, { actor: admin });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('0711222333');
    expect(json(res).data.payoutDetails).toBeUndefined();
    expect(json(res).data.hasPayoutDetails).toBe(true);
  });

  it('business-model guard: no subscription-payment table can reference a booking', async () => {
    const cols = await db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
      where table_name in ('payment_attempts','revenue_entries','subscription_invoices','provider_events') and column_name like '%booking%'`);
    expect([...cols]).toHaveLength(0);
  });
});
