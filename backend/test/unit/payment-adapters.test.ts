import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createPaystackClient, verifyPaystackSignature, type FetchFn } from '../../src/modules/payments/paystack.adapter.js';
import { createDarajaClient, darajaTimestamp, maskMsisdn, normaliseKenyanMsisdn } from '../../src/modules/payments/daraja.adapter.js';

interface Captured { url: string; init: RequestInit }

function fakeFetch(responses: Array<{ status?: number; body: unknown }>): { fetch: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const fetch: FetchFn = async (input, init) => {
    calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init: init ?? {} });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

describe('Paystack webhook signature', () => {
  const secret = 'sk_test_abc';
  const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'lm_1' } }));
  const good = createHmac('sha512', secret).update(body).digest('hex');

  it('accepts a valid HMAC-SHA512 over the raw body', () => {
    expect(verifyPaystackSignature(body, good, secret)).toBe(true);
  });
  it('rejects a tampered body, a wrong secret, and malformed signatures', () => {
    expect(verifyPaystackSignature(Buffer.from(body.toString().replace('lm_1', 'lm_2')), good, secret)).toBe(false);
    expect(verifyPaystackSignature(body, good, 'sk_test_other')).toBe(false);
    expect(verifyPaystackSignature(body, undefined, secret)).toBe(false);
    expect(verifyPaystackSignature(body, 'not-hex!', secret)).toBe(false);
    expect(verifyPaystackSignature(body, good.slice(0, 20), secret)).toBe(false);
  });
});

describe('Paystack client', () => {
  it('initialises a transaction with amount in minor units and a bearer secret', async () => {
    const { fetch, calls } = fakeFetch([{ body: { status: true, message: 'ok', data: { authorization_url: 'https://checkout', access_code: 'ac', reference: 'lm_1' } } }]);
    const client = createPaystackClient({ secretKey: 'sk_test_abc', baseUrl: 'https://api.paystack.co', fetch });
    const out = await client.initialize({ email: 'v@x.test', amountMinor: 150000, currency: 'KES', reference: 'lm_1', metadata: { attempt_id: 'a' } });
    expect(out.authorizationUrl).toBe('https://checkout');
    expect(calls[0]!.url).toBe('https://api.paystack.co/transaction/initialize');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_abc');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ amount: 150000, currency: 'KES', reference: 'lm_1', email: 'v@x.test' });
  });

  it('maps verify responses, including reusable authorizations', async () => {
    const { fetch } = fakeFetch([{ body: { status: true, message: 'ok', data: { id: 99, status: 'success', reference: 'lm_1', amount: 150000, currency: 'KES', authorization: { authorization_code: 'AUTH_x', reusable: true, last4: '4081' }, customer: { email: 'v@x.test' } } } }]);
    const v = await createPaystackClient({ secretKey: 's', baseUrl: 'https://api.paystack.co', fetch }).verify('lm_1');
    expect(v).toMatchObject({ status: 'success', amountMinor: 150000, transactionId: '99', authorization: { code: 'AUTH_x', reusable: true } });
  });

  it('surfaces provider rejections as 502 errors', async () => {
    const { fetch } = fakeFetch([{ status: 400, body: { status: false, message: 'Invalid key' } }]);
    await expect(createPaystackClient({ secretKey: 's', baseUrl: 'https://api.paystack.co', fetch }).verify('x')).rejects.toMatchObject({ statusCode: 502, code: 'PAYSTACK_REJECTED' });
  });
});

describe('Daraja helpers', () => {
  it('normalises Kenyan numbers and rejects invalid ones', () => {
    expect(normaliseKenyanMsisdn('0712 345 678')).toBe('254712345678');
    expect(normaliseKenyanMsisdn('+254112345678')).toBe('254112345678');
    expect(normaliseKenyanMsisdn('254712345678')).toBe('254712345678');
    expect(() => normaliseKenyanMsisdn('0812345678')).toThrow();
    expect(maskMsisdn('254712345678')).toBe('254******678');
  });
  it('formats timestamps in East Africa Time', () => {
    expect(darajaTimestamp(new Date('2026-11-24T21:05:09Z'))).toBe('20261125000509');
  });
});

describe('Daraja client', () => {
  const cfg = { environment: 'sandbox' as const, consumerKey: 'ck', consumerSecret: 'cs', shortcode: '174379', passkey: 'pk', transactionType: 'CustomerPayBillOnline' as const };

  it('fetches a token, then sends an STK push with the documented fields', async () => {
    const { fetch, calls } = fakeFetch([
      { body: { access_token: 'tok', expires_in: '3599' } },
      { body: { ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'mr_1', CustomerMessage: 'ok' } },
    ]);
    const out = await createDarajaClient({ ...cfg, fetch }).stkPush({ phone: '254712345678', amountKes: 1500, accountReference: 'LMabcdef1234XYZ', description: 'Subscription payment', callbackUrl: 'https://api.test/cb' });
    expect(out.checkoutRequestId).toBe('ws_CO_1');
    expect(calls[0]!.url).toBe('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('ck:cs').toString('base64')}`);
    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body).toMatchObject({ BusinessShortCode: '174379', TransactionType: 'CustomerPayBillOnline', Amount: 1500, PartyA: '254712345678', PartyB: '174379', PhoneNumber: '254712345678', CallBackURL: 'https://api.test/cb' });
    expect(body.AccountReference.length).toBeLessThanOrEqual(12);
    expect(body.TransactionDesc.length).toBeLessThanOrEqual(13);
    expect(Buffer.from(body.Password, 'base64').toString()).toBe(`174379pk${body.Timestamp}`);
  });

  it('refuses fractional shilling amounts', async () => {
    const { fetch } = fakeFetch([{ body: { access_token: 'tok' } }]);
    await expect(createDarajaClient({ ...cfg, fetch }).stkPush({ phone: '254712345678', amountKes: 10.5, accountReference: 'x', description: 'x', callbackUrl: 'https://x' })).rejects.toMatchObject({ statusCode: 422 });
  });

  it('reports "still processing" as a null result code', async () => {
    const { fetch } = fakeFetch([
      { body: { access_token: 'tok' } },
      { status: 500, body: { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' } },
      { body: { ResponseCode: '0', ResultCode: '1032', ResultDesc: 'Request cancelled by user' } },
    ]);
    const client = createDarajaClient({ ...cfg, fetch });
    expect((await client.stkQuery('ws_CO_1')).resultCode).toBeNull();
    expect((await client.stkQuery('ws_CO_1')).resultCode).toBe('1032');
  });
});
