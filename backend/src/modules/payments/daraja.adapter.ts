// Safaricom Daraja adapter: M-Pesa Express (STK Push), subscription payments only.
//   GET  /oauth/v1/generate?grant_type=client_credentials   (Basic auth) -> bearer token, ~1h
//   POST /mpesa/stkpush/v1/processrequest                    -> CheckoutRequestID
//   POST /mpesa/stkpushquery/v1/query                        -> final ResultCode
// STK Push is a payment *request*: the vendor approves it with their M-Pesa PIN. There is
// no automatic recurring deduction. Callbacks are unsigned, so they are only a trigger:
// the result is always confirmed through STK Query before anything is credited.
import { BadGatewayError, ValidationError } from '../../app/errors.js';
import type { FetchFn } from './paystack.adapter.js';

export interface StkPushResult {
  checkoutRequestId: string;
  merchantRequestId: string;
  customerMessage: string;
}

/** `null` resultCode = still being processed by M-Pesa. */
export interface StkQueryResult {
  resultCode: string | null;
  resultDesc: string;
}

export interface DarajaClient {
  stkPush(input: { phone: string; amountKes: number; accountReference: string; description: string; callbackUrl: string }): Promise<StkPushResult>;
  stkQuery(checkoutRequestId: string): Promise<StkQueryResult>;
}

export interface DarajaConfig {
  environment: 'sandbox' | 'production';
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  transactionType: 'CustomerPayBillOnline' | 'CustomerBuyGoodsOnline';
  partyB?: string | undefined;
  fetch?: FetchFn;
  timeoutMs?: number;
}

/** Normalise a Kenyan mobile number to 2547XXXXXXXX / 2541XXXXXXXX. */
export function normaliseKenyanMsisdn(input: string): string {
  const digits = input.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  const m = /^(?:254|0)?([17]\d{8})$/.exec(digits);
  if (!m?.[1]) throw new ValidationError('Enter a valid Safaricom number, e.g. 0712345678');
  return `254${m[1]}`;
}

export function maskMsisdn(msisdn: string): string {
  return `${msisdn.slice(0, 3)}******${msisdn.slice(-3)}`;
}

/** Daraja timestamps are YYYYMMDDHHmmss in East Africa Time (UTC+3). */
export function darajaTimestamp(now = new Date()): string {
  const eat = new Date(now.getTime() + 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${eat.getUTCFullYear()}${p(eat.getUTCMonth() + 1)}${p(eat.getUTCDate())}${p(eat.getUTCHours())}${p(eat.getUTCMinutes())}${p(eat.getUTCSeconds())}`;
}

/** Result codes that mean the request is final and unsuccessful. */
export const STK_RESULT_DESCRIPTIONS: Record<string, string> = {
  '0': 'Success',
  '1': 'Insufficient balance',
  '1032': 'Cancelled by user',
  '1037': 'Phone unreachable or no response',
  '2001': 'Wrong PIN',
  '1019': 'Transaction expired',
  '1001': 'Subscriber busy with another transaction',
};

export function createDarajaClient(cfg: DarajaConfig): DarajaClient {
  const doFetch = cfg.fetch ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const base = cfg.environment === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
  let token: { value: string; expiresAt: number } | null = null;

  async function request(path: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new BadGatewayError(`M-Pesa is unreachable (${(err as Error).name})`, 'DARAJA_UNREACHABLE');
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      // Some Daraja errors return non-JSON bodies; handled by the status check below.
    }
    return { status: res.status, json };
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const basic = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString('base64');
    const { status, json } = await request('/oauth/v1/generate?grant_type=client_credentials', { method: 'GET', headers: { Authorization: `Basic ${basic}` } });
    const value = typeof json.access_token === 'string' ? json.access_token : null;
    if (status !== 200 || !value) throw new BadGatewayError('M-Pesa authentication failed', 'DARAJA_AUTH_FAILED');
    const ttl = Number(json.expires_in ?? 3599);
    token = { value, expiresAt: Date.now() + (Number.isFinite(ttl) ? ttl : 3599) * 1000 };
    return value;
  }

  function password(timestamp: string): string {
    return Buffer.from(`${cfg.shortcode}${cfg.passkey}${timestamp}`).toString('base64');
  }

  return {
    async stkPush(input) {
      if (!Number.isInteger(input.amountKes) || input.amountKes < 1) throw new ValidationError('M-Pesa amounts must be whole shillings');
      const timestamp = darajaTimestamp();
      const { status, json } = await request('/mpesa/stkpush/v1/processrequest', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          BusinessShortCode: cfg.shortcode,
          Password: password(timestamp),
          Timestamp: timestamp,
          TransactionType: cfg.transactionType,
          Amount: input.amountKes,
          PartyA: input.phone,
          PartyB: cfg.partyB ?? cfg.shortcode,
          PhoneNumber: input.phone,
          CallBackURL: input.callbackUrl,
          AccountReference: input.accountReference.slice(0, 12),
          TransactionDesc: input.description.slice(0, 13),
        }),
      });
      if (status !== 200 || json.ResponseCode !== '0' || typeof json.CheckoutRequestID !== 'string') {
        const msg = typeof json.errorMessage === 'string' ? json.errorMessage : typeof json.ResponseDescription === 'string' ? json.ResponseDescription : `HTTP ${status}`;
        throw new BadGatewayError(`M-Pesa rejected the payment request: ${msg}`, 'DARAJA_REJECTED');
      }
      return {
        checkoutRequestId: json.CheckoutRequestID,
        merchantRequestId: typeof json.MerchantRequestID === 'string' ? json.MerchantRequestID : '',
        customerMessage: typeof json.CustomerMessage === 'string' ? json.CustomerMessage : 'Check your phone to complete payment',
      };
    },

    async stkQuery(checkoutRequestId) {
      const timestamp = darajaTimestamp();
      const { status, json } = await request('/mpesa/stkpushquery/v1/query', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ BusinessShortCode: cfg.shortcode, Password: password(timestamp), Timestamp: timestamp, CheckoutRequestID: checkoutRequestId }),
      });
      // While the customer hasn't finished, Daraja answers with an error "being processed".
      if (typeof json.errorCode === 'string' && json.errorCode === '500.001.1001') {
        return { resultCode: null, resultDesc: typeof json.errorMessage === 'string' ? json.errorMessage : 'Processing' };
      }
      if (status !== 200 || json.ResponseCode !== '0') {
        const msg = typeof json.errorMessage === 'string' ? json.errorMessage : `HTTP ${status}`;
        throw new BadGatewayError(`M-Pesa status query failed: ${msg}`, 'DARAJA_QUERY_FAILED');
      }
      const code = json.ResultCode;
      return {
        resultCode: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
        resultDesc: typeof json.ResultDesc === 'string' ? json.ResultDesc : '',
      };
    },
  };
}
