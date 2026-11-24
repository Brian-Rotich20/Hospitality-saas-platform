// Deterministic stand-ins for Paystack and Daraja. They implement the same client
// interfaces as the real adapters; the HTTP request shapes of the real adapters are
// covered separately by unit tests with a fake fetch.
import { createHmac } from 'node:crypto';
import { BadGatewayError } from '../../src/app/errors.js';
import type { PaystackClient, PaystackVerification } from '../../src/modules/payments/paystack.adapter.js';
import type { DarajaClient, StkQueryResult } from '../../src/modules/payments/daraja.adapter.js';

export const PAYSTACK_TEST_SECRET = 'sk_test_linkmart_webhook_secret';

export class FakePaystack implements PaystackClient {
  readonly initialized: { reference: string; amountMinor: number; email: string }[] = [];
  /** What `verify` returns per reference. Default: still pending. */
  readonly results = new Map<string, Partial<PaystackVerification>>();
  verifyCalls = 0;
  /** When set, the next initialize call fails the way the real adapter reports a rejection. */
  failNextInitialize: string | null = null;
  /** References for which verify fails (provider unreachable / reference unknown). */
  readonly verifyErrors = new Set<string>();

  async initialize(input: { email: string; amountMinor: number; currency: string; reference: string }) {
    if (this.failNextInitialize) {
      const msg = this.failNextInitialize;
      this.failNextInitialize = null;
      throw new BadGatewayError(`Paystack rejected the request: ${msg}`, 'PAYSTACK_REJECTED');
    }
    this.initialized.push({ reference: input.reference, amountMinor: input.amountMinor, email: input.email });
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, accessCode: `ac_${input.reference}`, reference: input.reference };
  }

  async verify(reference: string): Promise<PaystackVerification> {
    this.verifyCalls++;
    if (this.verifyErrors.has(reference)) throw new BadGatewayError('Paystack rejected the request: Transaction reference not found', 'PAYSTACK_REJECTED');
    const r = this.results.get(reference) ?? {};
    return {
      status: 'ongoing', reference, amountMinor: 0, currency: 'KES', transactionId: null, paidAt: null, channel: null,
      gatewayResponse: null, authorization: null, customerEmail: null, ...r,
    };
  }

  async chargeAuthorization(input: { reference: string; amountMinor: number }) {
    this.results.set(input.reference, { status: 'success', amountMinor: input.amountMinor, currency: 'KES', transactionId: `tx_${input.reference}` });
    return this.verify(input.reference);
  }

  succeed(reference: string, amountMinor: number, extra: Partial<PaystackVerification> = {}) {
    this.results.set(reference, { status: 'success', amountMinor, currency: 'KES', transactionId: `tx_${reference}`, paidAt: new Date().toISOString(), channel: 'card', ...extra });
  }

  fail(reference: string) {
    this.results.set(reference, { status: 'failed', gatewayResponse: 'Declined' });
  }

  /** The provider now reports the transaction as reversed (e.g. after a full refund). */
  reverse(reference: string) {
    const prior = this.results.get(reference) ?? {};
    this.results.set(reference, { ...prior, status: 'reversed' });
  }
}

export function signPaystack(body: string): string {
  return createHmac('sha512', PAYSTACK_TEST_SECRET).update(body).digest('hex');
}

/** A signed Paystack webhook request, ready for `call()`. */
export function paystackEvent(event: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ event, data });
  return { body, headers: { 'content-type': 'application/json', 'x-paystack-signature': signPaystack(body) } };
}

export class FakeDaraja implements DarajaClient {
  readonly pushes: { phone: string; amountKes: number; checkoutRequestId: string }[] = [];
  readonly queryResults = new Map<string, StkQueryResult>();
  private n = 0;

  async stkPush(input: { phone: string; amountKes: number }) {
    const checkoutRequestId = `ws_CO_${Date.now()}_${++this.n}`;
    this.pushes.push({ phone: input.phone, amountKes: input.amountKes, checkoutRequestId });
    return { checkoutRequestId, merchantRequestId: `mr_${this.n}`, customerMessage: 'Success. Request accepted for processing' };
  }

  async stkQuery(checkoutRequestId: string): Promise<StkQueryResult> {
    return this.queryResults.get(checkoutRequestId) ?? { resultCode: null, resultDesc: 'The transaction is being processed' };
  }
}

export function stkCallback(checkoutRequestId: string, resultCode: number, amountKes: number, receipt = 'SGH7XYZ123') {
  return {
    Body: {
      stkCallback: {
        MerchantRequestID: 'mr_1', CheckoutRequestID: checkoutRequestId, ResultCode: resultCode,
        ResultDesc: resultCode === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
        ...(resultCode === 0 ? { CallbackMetadata: { Item: [
          { Name: 'Amount', Value: amountKes }, { Name: 'MpesaReceiptNumber', Value: receipt },
          { Name: 'TransactionDate', Value: 20261124120000 }, { Name: 'PhoneNumber', Value: 254712345678 },
        ] } } : {}),
      },
    },
  };
}
