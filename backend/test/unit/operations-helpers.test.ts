import { describe, expect, it } from 'vitest';
import { eachIsolated } from '../../src/platform/batch.js';
import { QueueTimeoutError, withQueueTimeout } from '../../src/platform/queue/index.js';
import { eventReference, sanitizeProviderPayload } from '../../src/modules/payments/service.js';

describe('eachIsolated', () => {
  it('keeps going after a failing item and counts the failure', async () => {
    const seen: number[] = [];
    const res = await eachIsolated([1, 2, 3], 'test', String, async (n) => {
      if (n === 2) throw new Error('boom');
      seen.push(n);
    });
    expect(seen).toEqual([1, 3]);
    expect(res.failed).toBe(1);
  });
});

describe('withQueueTimeout', () => {
  it('rejects a queue call that never settles (Redis unreachable) instead of hanging', async () => {
    await expect(withQueueTimeout(new Promise(() => {}), 'never', 20)).rejects.toBeInstanceOf(QueueTimeoutError);
    await expect(withQueueTimeout(Promise.resolve(7), 'ok', 20)).resolves.toBe(7);
  });
});

describe('provider payload handling', () => {
  it('finds the reference in charge, refund and dispute events, and in STK callbacks', () => {
    expect(eventReference('paystack', { data: { reference: 'lm_a' } })).toBe('lm_a');
    expect(eventReference('paystack', { data: { transaction_reference: 'lm_b' } })).toBe('lm_b');
    expect(eventReference('paystack', { data: { transaction: { reference: 'lm_c' } } })).toBe('lm_c');
    expect(eventReference('paystack', { data: {} })).toBeNull();
    expect(eventReference('daraja', { Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1' } } })).toBe('ws_CO_1');
    expect(eventReference('daraja', 'not an object')).toBeNull();
  });

  it('strips card authorization codes and masks phone numbers without mutating the input', () => {
    const paystack = { event: 'charge.success', data: { authorization: { authorization_code: 'AUTH_x', signature: 'SIG', last4: '4081' }, customer: { email: 'v@x.test', customer_code: 'CUS_1' } } };
    const out = JSON.stringify(sanitizeProviderPayload('paystack', paystack));
    expect(out).not.toMatch(/AUTH_x|SIG|CUS_1/);
    expect(out).toContain('4081');
    expect(paystack.data.authorization.authorization_code).toBe('AUTH_x');

    const stk = { Body: { stkCallback: { CallbackMetadata: { Item: [{ Name: 'PhoneNumber', Value: 254712345678 }, { Name: 'Amount', Value: 1500 }] } } } };
    const masked = JSON.stringify(sanitizeProviderPayload('daraja', stk));
    expect(masked).toContain('254******678');
    expect(masked).not.toContain('254712345678');
    expect(masked).toContain('1500');
  });
});
