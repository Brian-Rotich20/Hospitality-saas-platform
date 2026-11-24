import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { call, db, json, makeAdmin, makeCustomer, makeListing, makeVendor, requestBooking, type Actor } from '../helpers/app.js';
import { FakeDaraja, FakePaystack, signPaystack, stkCallback } from '../helpers/fake-providers.js';
import { setPaymentClients, paymentsService } from '../../src/modules/payments/service.js';
import { subscriptionsService } from '../../src/modules/subscriptions/service.js';
import { vendorSubscriptions, subscriptionInvoices, paymentAttempts, revenueEntries, providerEvents, subscriptionPlans } from '../../src/platform/database/schema/subscriptions.js';
import { outbox } from '../../src/platform/database/schema/platform.js';
import { addDays, addMonthsUTC } from '../../src/platform/time.js';

const CALLBACK_TOKEN = 'cb_test_token_0123456789abcdef';
const paystack = new FakePaystack();
const daraja = new FakeDaraja();
let admin: Actor;

async function subOf(vendorId: string) {
  return (await db.query.vendorSubscriptions.findFirst({ where: eq(vendorSubscriptions.vendorId, vendorId) }))!;
}

/** Move "now" forward for one vendor's subscription by shifting its timestamps back. */
async function endTrial(vendorId: string) {
  await db.update(vendorSubscriptions).set({ trialEndsAt: new Date(Date.now() - 60_000), trialStartedAt: addMonthsUTC(new Date(Date.now() - 60_000), -1) }).where(eq(vendorSubscriptions.vendorId, vendorId));
}

async function paystackWebhook(reference: string, event = 'charge.success') {
  const body = JSON.stringify({ event, data: { id: 12345, reference, status: 'success' } });
  return call('POST', '/api/payments/paystack/webhook', { body, headers: { 'content-type': 'application/json', 'x-paystack-signature': signPaystack(body) } });
}

beforeAll(async () => {
  setPaymentClients({ paystack, daraja });
  admin = await makeAdmin();
  // Start from a known state: no active plan.
  await db.update(subscriptionPlans).set({ isActive: false });
});

afterAll(() => setPaymentClients({ paystack: undefined as never, daraja: undefined as never }));

describe('vendor onboarding and trial', () => {
  it('instant self-service onboarding creates the vendor and a one-month trial atomically', async () => {
    const v = await makeVendor('Trial Co');
    const sub = await subOf(v.vendorId);
    expect(sub.status).toBe('trialing');
    expect(sub.origin).toBe('onboarding');
    expect(addMonthsUTC(sub.trialStartedAt, 1).getTime()).toBe(sub.trialEndsAt.getTime());
    const me = json(await call('GET', '/api/subscriptions/me', { actor: v }));
    expect(me.data).toMatchObject({ status: 'trialing', entitled: true });
    // Onboarding is idempotent.
    const again = await call('POST', '/api/vendors/become', { actor: v });
    expect(again.statusCode).toBe(200);
    expect((await db.select().from(vendorSubscriptions).where(eq(vendorSubscriptions.vendorId, v.vendorId))).length).toBe(1);
  });

  it('administrators cannot become vendors', async () => {
    const res = await call('POST', '/api/vendors/become', { actor: admin });
    expect(res.statusCode).toBe(403);
  });

  it('trial end without a configured price holds billing and keeps the vendor entitled', async () => {
    const v = await makeVendor('No Plan Co');
    await endTrial(v.vendorId);
    await subscriptionsService.runLifecycle();
    const sub = await subOf(v.vendorId);
    expect(sub.status).toBe('trialing');
    expect(sub.billingHoldReason).toBe('no_active_plan');
    expect((await subscriptionsService.getEntitlement(v.vendorId)).entitled).toBe(true);
  });
});

describe('plans are admin-configured', () => {
  it('rejects non-admins and fractional shillings; activating a plan replaces the previous one', async () => {
    const v = await makeVendor('Plan Viewer');
    expect((await call('POST', '/api/admin/subscriptions/plans', { actor: v, body: { code: 'x', name: 'X', amountMinor: 100000, currency: 'KES' } })).statusCode).toBe(403);
    expect((await call('POST', '/api/admin/subscriptions/plans', { actor: admin, body: { code: 'bad', name: 'Bad', amountMinor: 100050, currency: 'KES', activate: true } })).statusCode).toBe(422);
    const p1 = json(await call('POST', '/api/admin/subscriptions/plans', { actor: admin, body: { code: 'monthly-v1', name: 'Monthly', amountMinor: 150000, currency: 'KES', activate: true } })).data;
    const p2 = json(await call('POST', '/api/admin/subscriptions/plans', { actor: admin, body: { code: 'monthly-v2', name: 'Monthly', amountMinor: 200000, currency: 'KES', activate: true } })).data;
    const active = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.isActive, true));
    expect(active.map((p) => p.id)).toEqual([p2.id]);
    // Restore v1 as the active price for the rest of this file.
    await call('PATCH', `/api/admin/subscriptions/plans/${p1.id}`, { actor: admin, body: { active: true } });
  });
});

describe('billing lifecycle', () => {
  let v: Actor & { vendorId: string };
  let listingId: string;

  beforeAll(async () => {
    v = await makeVendor('Billing Co');
    listingId = await makeListing(v);
  });

  it('trial end issues an invoice at the configured price and moves to past_due (still entitled during grace)', async () => {
    await endTrial(v.vendorId);
    await subscriptionsService.runLifecycle();
    const sub = await subOf(v.vendorId);
    expect(sub.status).toBe('past_due');
    const inv = (await db.query.subscriptionInvoices.findFirst({ where: eq(subscriptionInvoices.subscriptionId, sub.id) }))!;
    expect(inv).toMatchObject({ status: 'open', amountMinor: 150000, currency: 'KES' });
    expect(sub.graceEndsAt!.getTime()).toBe(addDays(inv.dueAt, 7).getTime());
    expect((await subscriptionsService.getEntitlement(v.vendorId)).entitled).toBe(true);
    // Re-running the tick never issues a second invoice for the same period.
    await subscriptionsService.runLifecycle();
    expect((await db.select().from(subscriptionInvoices).where(eq(subscriptionInvoices.subscriptionId, sub.id))).length).toBe(1);
    // A payment-due reminder was enqueued exactly once.
    const reminders = await db.select().from(outbox).where(sql`${outbox.dedupeKey} like ${`payment-due:${inv.id}:%`}`);
    expect(reminders.length).toBe(1);
  });

  it('grace expiry suspends the subscription: listings hidden, publishing and accepting blocked', async () => {
    const c = await makeCustomer();
    const reqId = json(await requestBooking(c, listingId, 15, 15)).data.id as string;
    await db.update(vendorSubscriptions).set({ graceEndsAt: new Date(Date.now() - 1000) }).where(eq(vendorSubscriptions.vendorId, v.vendorId));
    await subscriptionsService.runLifecycle();
    expect((await subOf(v.vendorId)).status).toBe('suspended');

    expect((await call('GET', `/api/listings/${listingId}`)).statusCode).toBe(404);
    const acc = await call('PUT', `/api/bookings/${reqId}/accept`, { actor: v });
    expect(acc.statusCode).toBe(403);
    expect(json(acc).code).toBe('SUBSCRIPTION_INACTIVE');
    // Billing stays reachable so the vendor can pay.
    expect((await call('GET', '/api/subscriptions/me', { actor: v })).statusCode).toBe(200);
  });

  it('Paystack: checkout initiation is idempotent and only a verified webhook activates the subscription', async () => {
    const key = 'idem-key-paystack-0001';
    const r1 = await call('POST', '/api/subscriptions/me/payments', { actor: v, body: { provider: 'paystack' }, headers: { 'idempotency-key': key } });
    expect(r1.statusCode).toBe(202);
    const attempt = json(r1).data;
    expect(attempt).toMatchObject({ provider: 'paystack', status: 'pending', amountMinor: 150000 });
    expect(attempt.checkoutUrl).toContain('checkout.paystack.test');
    const r2 = await call('POST', '/api/subscriptions/me/payments', { actor: v, body: { provider: 'paystack' }, headers: { 'idempotency-key': key } });
    expect(json(r2).data.id).toBe(attempt.id);
    expect(paystack.initialized.length).toBe(1);

    // Webhook arrives, but the provider says the charge is not complete: nothing is credited.
    expect((await paystackWebhook(attempt.reference)).statusCode).toBe(200);
    expect((await subOf(v.vendorId)).status).toBe('suspended');

    // Forged webhook: rejected outright.
    const forged = JSON.stringify({ event: 'charge.success', data: { id: 1, reference: attempt.reference } });
    const bad = await call('POST', '/api/payments/paystack/webhook', { body: forged, headers: { 'content-type': 'application/json', 'x-paystack-signature': 'deadbeef' } });
    expect(bad.statusCode).toBe(401);

    // Provider confirms success -> verified -> invoice paid, subscription active, revenue recorded.
    paystack.succeed(attempt.reference, 150000);
    const body = JSON.stringify({ event: 'charge.success', data: { id: 777, reference: attempt.reference } });
    const ok = await call('POST', '/api/payments/paystack/webhook', { body, headers: { 'content-type': 'application/json', 'x-paystack-signature': signPaystack(body) } });
    expect(ok.statusCode).toBe(200);
    const sub = await subOf(v.vendorId);
    expect(sub.status).toBe('active');
    expect((await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, attempt.id) }))!.status).toBe('succeeded');
    const rev = await db.select().from(revenueEntries).where(eq(revenueEntries.attemptId, attempt.id));
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ amountMinor: 150000, entryType: 'subscription_payment', requiresReview: false });

    // Duplicate delivery of the same event: acknowledged, no double credit.
    const dup = await call('POST', '/api/payments/paystack/webhook', { body, headers: { 'content-type': 'application/json', 'x-paystack-signature': signPaystack(body) } });
    expect(json(dup).duplicate).toBe(true);
    expect(await db.select().from(revenueEntries).where(eq(revenueEntries.attemptId, attempt.id))).toHaveLength(1);

    // Listings are public again.
    expect((await call('GET', `/api/listings/${listingId}`)).statusCode).toBe(200);
  });

  it('an amount mismatch is never credited', async () => {
    const w = await makeVendor('Mismatch Co');
    await endTrial(w.vendorId);
    await subscriptionsService.runLifecycle();
    const a = json(await call('POST', '/api/subscriptions/me/payments', { actor: w, body: { provider: 'paystack' } })).data;
    paystack.succeed(a.reference, 100); // provider reports a different amount
    await paystackWebhook(a.reference);
    expect((await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, a.id) }))!.failureReason).toMatch(/mismatch/);
    expect((await subOf(w.vendorId)).status).toBe('past_due');
  });

  it('monthly renewal issues the next invoice at period end; failed payment notifies and keeps the invoice open', async () => {
    await db.update(vendorSubscriptions).set({ currentPeriodEnd: new Date(Date.now() - 1000) }).where(eq(vendorSubscriptions.vendorId, v.vendorId));
    await subscriptionsService.runLifecycle();
    const sub = await subOf(v.vendorId);
    expect(sub.status).toBe('past_due');
    const open = await db.select().from(subscriptionInvoices).where(sql`${subscriptionInvoices.subscriptionId} = ${sub.id} AND ${subscriptionInvoices.status} = 'open'`);
    expect(open).toHaveLength(1);

    const a = json(await call('POST', '/api/subscriptions/me/payments', { actor: v, body: { provider: 'paystack' } })).data;
    paystack.fail(a.reference);
    expect((await call('GET', `/api/subscriptions/me/payments/${a.id}`, { actor: v })).statusCode).toBe(200);
    // Pending attempts are re-verified server-side by reconciliation (and by polling after a debounce).
    await db.update(paymentAttempts).set({ updatedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(paymentAttempts.id, a.id));
    await paymentsService.reconcilePending();
    expect((await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, a.id) }))!.status).toBe('failed');
    expect(await db.query.outbox.findFirst({ where: eq(outbox.dedupeKey, `payment-failed:${a.id}`) })).toBeTruthy();
    expect((await db.query.subscriptionInvoices.findFirst({ where: eq(subscriptionInvoices.id, open[0]!.id) }))!.status).toBe('open');
  });

  it('M-Pesa STK: callback with a bad token is rejected; a valid callback is verified by STK Query before crediting', async () => {
    const r = await call('POST', '/api/subscriptions/me/payments', { actor: v, body: { provider: 'mpesa', phone: '0712345678' } });
    expect(r.statusCode).toBe(202);
    const a = json(r).data;
    expect(a).toMatchObject({ provider: 'mpesa', status: 'pending', phone: '254******678' });
    expect(daraja.pushes.at(-1)).toMatchObject({ phone: '254712345678', amountKes: 1500 });
    const checkoutId = daraja.pushes.at(-1)!.checkoutRequestId;

    expect((await call('POST', '/api/payments/daraja/callback/wrong-token-value-000000', { body: stkCallback(checkoutId, 0, 1500) })).statusCode).toBe(404);

    // Callback claims success but STK Query says still processing: not credited yet.
    expect((await call('POST', `/api/payments/daraja/callback/${CALLBACK_TOKEN}`, { body: stkCallback(checkoutId, 0, 1500) })).statusCode).toBe(200);
    expect((await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, a.id) }))!.status).toBe('pending');

    // M-Pesa confirms; reconciliation retries the stored, unprocessed-equivalent attempt.
    daraja.queryResults.set(checkoutId, { resultCode: '0', resultDesc: 'Success' });
    await db.update(paymentAttempts).set({ updatedAt: new Date(Date.now() - 60 * 60_000) }).where(eq(paymentAttempts.id, a.id));
    await paymentsService.reconcilePending();
    const done = (await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, a.id) }))!;
    expect(done.status).toBe('succeeded');
    expect(done.providerReceipt).toBe('SGH7XYZ123');
    expect((await subOf(v.vendorId)).status).toBe('active');

    // Safaricom retries the same callback: acknowledged as duplicate.
    const dup = await call('POST', `/api/payments/daraja/callback/${CALLBACK_TOKEN}`, { body: stkCallback(checkoutId, 0, 1500) });
    expect(dup.statusCode).toBe(200);
    expect((await db.select().from(providerEvents).where(sql`${providerEvents.eventKey} like ${`${checkoutId}:%`}`))).toHaveLength(1);
    expect(await db.select().from(revenueEntries).where(eq(revenueEntries.attemptId, a.id))).toHaveLength(1);
  });

  it('a user-cancelled STK request is recorded as cancelled and nothing is credited', async () => {
    const w = await makeVendor('Cancel STK Co');
    await endTrial(w.vendorId);
    await subscriptionsService.runLifecycle();
    const a = json(await call('POST', '/api/subscriptions/me/payments', { actor: w, body: { provider: 'mpesa', phone: '0712000111' } })).data;
    const checkoutId = daraja.pushes.at(-1)!.checkoutRequestId;
    daraja.queryResults.set(checkoutId, { resultCode: '1032', resultDesc: 'Request cancelled by user' });
    await call('POST', `/api/payments/daraja/callback/${CALLBACK_TOKEN}`, { body: stkCallback(checkoutId, 1032, 1500) });
    expect((await db.query.paymentAttempts.findFirst({ where: eq(paymentAttempts.id, a.id) }))!.status).toBe('cancelled');
    expect((await subOf(w.vendorId)).status).toBe('past_due');
  });

  it('suspended subscriptions expire after the configured period; open invoices are voided; resubscribing issues a fresh invoice', async () => {
    const w = await makeVendor('Expire Co');
    await endTrial(w.vendorId);
    await subscriptionsService.runLifecycle();
    await db.update(vendorSubscriptions).set({ graceEndsAt: new Date(Date.now() - 1000) }).where(eq(vendorSubscriptions.vendorId, w.vendorId));
    await subscriptionsService.runLifecycle();
    await db.update(vendorSubscriptions).set({ suspendedAt: addDays(new Date(), -31) }).where(eq(vendorSubscriptions.vendorId, w.vendorId));
    await subscriptionsService.runLifecycle();
    const sub = await subOf(w.vendorId);
    expect(sub.status).toBe('expired');
    expect(await db.select().from(subscriptionInvoices).where(sql`${subscriptionInvoices.subscriptionId} = ${sub.id} AND ${subscriptionInvoices.status} = 'open'`)).toHaveLength(0);

    const a = json(await call('POST', '/api/subscriptions/me/payments', { actor: w, body: { provider: 'paystack' } })).data;
    expect(a.status).toBe('pending');
    paystack.succeed(a.reference, 150000);
    await paystackWebhook(a.reference);
    expect((await subOf(w.vendorId)).status).toBe('active');
  });

  it('cancellation takes effect at the end of the paid period', async () => {
    expect((await call('POST', '/api/subscriptions/me/cancel', { actor: v })).statusCode).toBe(200);
    expect((await subOf(v.vendorId))).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    await db.update(vendorSubscriptions).set({ currentPeriodEnd: new Date(Date.now() - 1000) }).where(eq(vendorSubscriptions.vendorId, v.vendorId));
    await subscriptionsService.runLifecycle();
    expect((await subOf(v.vendorId)).status).toBe('cancelled');
    expect((await subscriptionsService.getEntitlement(v.vendorId)).entitled).toBe(false);
  });

  it('no payment is due during an active trial', async () => {
    const w = await makeVendor('Early Payer');
    const res = await call('POST', '/api/subscriptions/me/payments', { actor: w, body: { provider: 'paystack' } });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('NO_PAYMENT_DUE');
  });

  it('vendors can only see their own billing history', async () => {
    const other = await makeVendor('Snooper Co');
    const mine = json(await call('GET', '/api/subscriptions/me/payments', { actor: v })).data as { id: string }[];
    expect(mine.length).toBeGreaterThan(0);
    expect((await call('GET', `/api/subscriptions/me/payments/${mine[0]!.id}`, { actor: other })).statusCode).toBe(404);
    expect(json(await call('GET', '/api/subscriptions/me/invoices', { actor: other })).data).toHaveLength(0);
  });
});

describe('vendors that predate subscriptions (no transition policy yet)', () => {
  it('stay entitled, are listed for admins, and are enrolled only by an explicit admin action', async () => {
    const v = await makeVendor('Legacy Co');
    // Simulate a pre-existing vendor: remove its subscription row.
    await db.delete(vendorSubscriptions).where(eq(vendorSubscriptions.vendorId, v.vendorId));
    expect(await subscriptionsService.getEntitlement(v.vendorId)).toMatchObject({ entitled: true, status: 'legacy_unenrolled' });
    await subscriptionsService.runLifecycle();
    expect(await db.query.vendorSubscriptions.findFirst({ where: eq(vendorSubscriptions.vendorId, v.vendorId) })).toBeUndefined();

    const list = json(await call('GET', '/api/admin/subscriptions/unenrolled', { actor: admin })).data as { id: string }[];
    expect(list.some((x) => x.id === v.vendorId)).toBe(true);
    const enrol = await call('POST', `/api/admin/subscriptions/unenrolled/${v.vendorId}/enrol`, { actor: admin });
    expect(enrol.statusCode).toBe(201);
    expect((await subOf(v.vendorId))).toMatchObject({ status: 'trialing', origin: 'admin_enrolment' });
  });
});

describe('revenue reporting', () => {
  it('sums the append-only journal', async () => {
    const res = json(await call('GET', `/api/admin/subscriptions/revenue?from=2000-01-01&to=2100-01-01`, { actor: admin })).data as { totalMinor: number; entryType: string }[];
    const pay = res.find((r) => r.entryType === 'subscription_payment');
    expect(pay!.totalMinor).toBeGreaterThanOrEqual(300000);
  });
});
