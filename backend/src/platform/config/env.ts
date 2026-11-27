// Single source of configuration. Every other module reads config from here, never from
// process.env directly. Parsed once at import; the process refuses to start on invalid config.
import dotenv from 'dotenv';
import { z } from 'zod';

// In tests the harness injects env before import; never let a developer's .env override it.
if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });

const csv = z.string().transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));
const intList = z.string().transform((s, ctx) => {
  const out = s.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  if (out.some((n) => !Number.isInteger(n) || n < 0)) {
    ctx.addIssue({ code: 'custom', message: 'must be a comma-separated list of non-negative integers' });
    return z.NEVER;
  }
  return out;
});
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const optionalSecret = z.string().min(1).optional();

/**
 * Which proxies may set X-Forwarded-For. Deliberately never "trust everything":
 *   false            -> use the socket address; ignore forwarded headers (default)
 *   1..5             -> trust exactly that many proxy hops in front of the API
 *   ip/cidr list     -> trust forwarded headers only from these proxy addresses
 */
export type TrustProxySetting = false | number | string[];
const CIDR = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)(\/\d{1,3})?$/;
export function parseTrustProxy(raw: string): TrustProxySetting | { error: string } {
  const v = raw.trim();
  if (v === '' || v === 'false') return false;
  if (v === 'true') return { error: 'TRUST_PROXY=true (trust any proxy) is not allowed: set a hop count (1-5) or the proxy IP/CIDR list' };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n >= 1 && n <= 5 ? n : { error: 'TRUST_PROXY hop count must be between 1 and 5' };
  }
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0 || !list.every((s) => CIDR.test(s))) return { error: 'TRUST_PROXY must be false, a hop count (1-5), or a comma-separated list of IP addresses/CIDR ranges' };
  return list;
}
const trustProxy = z.string().prefault('false').transform((s, ctx): TrustProxySetting => {
  const r = parseTrustProxy(s);
  if (typeof r === 'object' && !Array.isArray(r)) {
    ctx.addIssue({ code: 'custom', message: r.error });
    return z.NEVER;
  }
  return r;
});

const envSchema = z.object({
  // ── Application
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_PUBLIC_URL: z.string().url(),          // externally reachable base URL of this API (webhooks, callbacks)
  FRONTEND_URL: z.string().url(),            // used in email links
  CORS_ORIGINS: csv,                         // allowed browser origins (also Better Auth trusted origins)
  SWAGGER_ENABLED: bool.prefault('false'),
  RATE_LIMIT_ENABLED: bool.prefault('true'),
  // Proxies allowed to set X-Forwarded-For (client IP for rate limits and the Daraja IP
  // allow-list). See parseTrustProxy; unrestricted trust is rejected.
  TRUST_PROXY: trustProxy,
  COOKIE_SECRET: z.string().min(32),

  // ── Database
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // ── Redis (cache, rate limit, BullMQ)
  REDIS_URL: z.string().url(),
  CACHE_TIMEOUT_MS: z.coerce.number().int().positive().default(250),
  QUEUE_PREFIX: z.string().default('linkmart'),

  // ── Better Auth
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,

  // ── Storage
  STORAGE_PROVIDER: z.enum(['cloudinary', 's3']).default('cloudinary'),
  CLOUDINARY_CLOUD_NAME: optionalSecret,
  CLOUDINARY_API_KEY: optionalSecret,
  CLOUDINARY_API_SECRET: optionalSecret,
  AWS_REGION: optionalSecret,
  AWS_ACCESS_KEY_ID: optionalSecret,
  AWS_SECRET_ACCESS_KEY: optionalSecret,
  AWS_S3_BUCKET: optionalSecret,
  MAX_FILE_SIZE: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  ALLOWED_IMAGE_TYPES: csv.prefault('image/jpeg,image/png,image/webp'),

  // ── Email (Brevo). MAIL_TRANSPORT=memory captures mail in-process (tests, local dev).
  MAIL_TRANSPORT: z.enum(['brevo', 'memory', 'log']).default('brevo'),
  BREVO_API_KEY: optionalSecret,
  MAIL_FROM_EMAIL: z.string().email().optional(),
  MAIL_FROM_NAME: z.string().default('LinkMart'),

  // ── Bookings
  BOOKING_RESPONSE_HOURS: z.coerce.number().int().positive().default(24),
  BOOKING_MAX_OPEN_REQUESTS_PER_CUSTOMER: z.coerce.number().int().positive().default(5),
  BOOKING_AUTO_COMPLETE_DAYS: z.coerce.number().int().min(0).default(2),
  MESSAGING_OPEN_DAYS_AFTER_COMPLETION: z.coerce.number().int().min(0).default(30),

  // ── Subscriptions (prices are configured by admins in the database, never here)
  SUBSCRIPTION_GRACE_DAYS: z.coerce.number().int().min(0).default(7),
  SUBSCRIPTION_EXPIRE_AFTER_SUSPENDED_DAYS: z.coerce.number().int().min(1).default(30),
  SUBSCRIPTION_TRIAL_REMINDER_DAYS: intList.prefault('7,3,1'),
  SUBSCRIPTION_PAYMENT_REMINDER_DAYS: intList.prefault('0,2,4,6'),
  PAYMENT_PENDING_RECONCILE_MINUTES: z.coerce.number().int().positive().default(10),

  // ── Paystack (subscription payments only)
  PAYSTACK_ENABLED: bool.prefault('false'),
  PAYSTACK_SECRET_KEY: optionalSecret,
  PAYSTACK_BASE_URL: z.string().url().default('https://api.paystack.co'),
  PAYSTACK_CALLBACK_URL: z.string().url().optional(),   // where Paystack checkout redirects the vendor
  PAYSTACK_RECURRING_ENABLED: bool.prefault('false'),     // saved-card renewals (reusable authorizations only)

  // ── Safaricom Daraja / M-Pesa STK Push (subscription payments only)
  DARAJA_ENABLED: bool.prefault('false'),
  DARAJA_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  DARAJA_CONSUMER_KEY: optionalSecret,
  DARAJA_CONSUMER_SECRET: optionalSecret,
  DARAJA_SHORTCODE: optionalSecret,                      // BusinessShortCode (paybill or HO number)
  DARAJA_PASSKEY: optionalSecret,
  DARAJA_TRANSACTION_TYPE: z.enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline']).default('CustomerPayBillOnline'),
  DARAJA_PARTY_B: optionalSecret,                        // till number for Buy Goods; defaults to shortcode
  DARAJA_CALLBACK_TOKEN: z.string().min(24).optional(),  // secret path segment; callbacks are unsigned
  DARAJA_ALLOWED_IPS: csv.optional(),                    // optional allow-list of Safaricom callback IPs
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report variable names and problems only, never values.
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  const missing: string[] = [];
  if (e.PAYSTACK_ENABLED && !e.PAYSTACK_SECRET_KEY) missing.push('PAYSTACK_SECRET_KEY');
  if (e.DARAJA_ENABLED) {
    for (const k of ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE', 'DARAJA_PASSKEY', 'DARAJA_CALLBACK_TOKEN'] as const) {
      if (!e[k]) missing.push(k);
    }
  }
  if (e.MAIL_TRANSPORT === 'brevo' && (!e.BREVO_API_KEY || !e.MAIL_FROM_EMAIL)) missing.push('BREVO_API_KEY/MAIL_FROM_EMAIL');
  if (e.NODE_ENV === 'production' && e.MAIL_TRANSPORT !== 'brevo') missing.push('MAIL_TRANSPORT=brevo (required in production)');
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  return e;
}

export const env = load();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
