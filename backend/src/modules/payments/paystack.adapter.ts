// Paystack adapter (subscription payments only).
// API reference: https://paystack.com/docs/api/transaction/
//   POST /transaction/initialize       hosted checkout
//   GET  /transaction/verify/:ref      authoritative status (always called before crediting)
//   POST /transaction/charge_authorization   saved-card renewal (reusable authorizations only)
// Webhooks: x-paystack-signature = hex HMAC-SHA512 of the raw body, keyed by the secret key.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { BadGatewayError } from '../../app/errors.js';

export type FetchFn = typeof fetch;

export type PaystackTxStatus = 'success' | 'failed' | 'abandoned' | 'reversed' | 'pending' | 'ongoing' | 'processing' | 'queued' | 'unknown';

export interface PaystackVerification {
  status: PaystackTxStatus;
  reference: string;
  amountMinor: number;
  currency: string;
  transactionId: string | null;
  paidAt: string | null;
  channel: string | null;
  gatewayResponse: string | null;
  authorization: { code: string; reusable: boolean; last4: string | null; brand: string | null } | null;
  customerEmail: string | null;
}

export interface PaystackClient {
  initialize(input: { email: string; amountMinor: number; currency: string; reference: string; callbackUrl?: string | undefined; metadata: Record<string, string> }):
    Promise<{ authorizationUrl: string; accessCode: string; reference: string }>;
  verify(reference: string): Promise<PaystackVerification>;
  chargeAuthorization(input: { authorizationCode: string; email: string; amountMinor: number; currency: string; reference: string; metadata: Record<string, string> }): Promise<PaystackVerification>;
}

/** Verify a webhook signature. `rawBody` must be the exact bytes received. */
export function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined, secretKey: string): boolean {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface PaystackEnvelope<T> { status: boolean; message: string; data: T }

interface RawTx {
  id?: number; status?: string; reference?: string; amount?: number; currency?: string; paid_at?: string | null;
  channel?: string | null; gateway_response?: string | null;
  authorization?: { authorization_code?: string; reusable?: boolean; last4?: string; brand?: string } | null;
  customer?: { email?: string } | null;
}

const KNOWN: readonly PaystackTxStatus[] = ['success', 'failed', 'abandoned', 'reversed', 'pending', 'ongoing', 'processing', 'queued'];

function toVerification(d: RawTx, fallbackRef: string): PaystackVerification {
  const status = (KNOWN as readonly string[]).includes(d.status ?? '') ? (d.status as PaystackTxStatus) : 'unknown';
  const a = d.authorization;
  return {
    status,
    reference: d.reference ?? fallbackRef,
    amountMinor: typeof d.amount === 'number' ? d.amount : -1,
    currency: d.currency ?? '',
    transactionId: d.id != null ? String(d.id) : null,
    paidAt: d.paid_at ?? null,
    channel: d.channel ?? null,
    gatewayResponse: d.gateway_response ?? null,
    authorization: a?.authorization_code
      ? { code: a.authorization_code, reusable: a.reusable === true, last4: a.last4 ?? null, brand: a.brand ?? null }
      : null,
    customerEmail: d.customer?.email ?? null,
  };
}

export function createPaystackClient(opts: { secretKey: string; baseUrl: string; fetch?: FetchFn; timeoutMs?: number }): PaystackClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<PaystackEnvelope<T>> {
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${opts.secretKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BadGatewayError(`Paystack is unreachable (${(err as Error).name})`, 'PAYSTACK_UNREACHABLE');
    }
    let json: PaystackEnvelope<T>;
    try {
      json = (await res.json()) as PaystackEnvelope<T>;
    } catch {
      throw new BadGatewayError(`Paystack returned an unreadable response (HTTP ${res.status})`, 'PAYSTACK_BAD_RESPONSE');
    }
    if (!res.ok || json.status !== true) {
      throw new BadGatewayError(`Paystack rejected the request: ${json.message ?? `HTTP ${res.status}`}`, 'PAYSTACK_REJECTED');
    }
    return json;
  }

  return {
    async initialize(input) {
      const r = await call<{ authorization_url: string; access_code: string; reference: string }>('POST', '/transaction/initialize', {
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
        metadata: input.metadata,
      });
      return { authorizationUrl: r.data.authorization_url, accessCode: r.data.access_code, reference: r.data.reference };
    },
    async verify(reference) {
      const r = await call<RawTx>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      return toVerification(r.data, reference);
    },
    async chargeAuthorization(input) {
      const r = await call<RawTx>('POST', '/transaction/charge_authorization', {
        authorization_code: input.authorizationCode,
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        metadata: input.metadata,
      });
      return toVerification(r.data, input.reference);
    },
  };
}
