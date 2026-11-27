// Integration test helpers. Everything goes through the real HTTP layer (app.inject),
// real Better Auth sessions, and a real PostgreSQL + Redis (Testcontainers).
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, type sql } from 'drizzle-orm';
import { buildApp } from '../../src/app/build-app.js';
import { db } from '../../src/platform/database/client.js';
import { users } from '../../src/platform/database/schema/users.js';
import { vendorSubscriptions } from '../../src/platform/database/schema/subscriptions.js';
import { memoryMailer } from '../../src/platform/mailer/index.js';
import { todayInNairobi } from '../../src/platform/time.js';

export const ORIGIN = 'http://localhost:5173';
let app: FastifyInstance | undefined;

export async function getApp(): Promise<FastifyInstance> {
  app ??= await buildApp();
  await app.ready();
  return app;
}

export interface Actor { cookie: string; userId: string; email: string }

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function call(method: Method, url: string, opts: { actor?: Actor | undefined; body?: unknown; headers?: Record<string, string> } = {}): Promise<LightMyRequestResponse> {
  const a = await getApp();
  return a.inject({
    method, url,
    headers: { origin: ORIGIN, ...(opts.actor ? { cookie: opts.actor.cookie } : {}), ...(opts.headers ?? {}) },
    ...(opts.body !== undefined ? { payload: opts.body as Record<string, unknown> } : {}),
  });
}

export function json<T = any>(res: LightMyRequestResponse): T {
  return res.json<T>();
}

function cookieFrom(res: LightMyRequestResponse): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

/** Sign up through Better Auth; optionally complete email verification with the emailed OTP. */
export async function signUp(opts: { verified?: boolean; name?: string } = {}): Promise<Actor> {
  const email = `user-${randomUUID()}@test.linkmart.local`;
  const res = await call('POST', '/api/auth/sign-up/email', { body: { email, password: 'correct-horse-battery-staple', name: opts.name ?? 'Test User' } });
  if (res.statusCode !== 200) throw new Error(`sign-up failed ${res.statusCode}: ${res.body}`);
  const cookie = cookieFrom(res);
  const user = await db.query.users.findFirst({ where: eq(users.email, email), columns: { id: true } });
  if (!user) throw new Error('user not created');
  const actor = { cookie, userId: user.id, email };
  if (opts.verified !== false) await verifyEmail(actor);
  return actor;
}

export function lastOtpFor(email: string): string {
  const mail = [...memoryMailer.sent].reverse().find((m) => m.to === email && m.tag === 'auth.otp');
  const otp = mail?.html.match(/>(\d{6})</)?.[1];
  if (!otp) throw new Error(`no OTP email for ${email}`);
  return otp;
}

export async function verifyEmail(actor: Actor): Promise<void> {
  const res = await call('POST', '/api/otp/verify-email', { actor, body: { otp: lastOtpFor(actor.email) } });
  if (res.statusCode !== 200) throw new Error(`verify failed ${res.statusCode}: ${res.body}`);
}

export async function makeCustomer(): Promise<Actor> {
  return signUp({ name: 'Customer Person' });
}

/** Business contact every test vendor gets unless `withContact: false` (publishing needs it). */
export const TEST_CONTACT = { businessEmail: 'bookings@venue.test', phoneNumber: '0712345678', whatsappNumber: '+254 712 345 679' };

export async function makeVendor(businessName = 'Test Venue Co', opts: { withContact?: boolean } = {}): Promise<Actor & { vendorId: string }> {
  const actor = await signUp({ name: 'Vendor Person' });
  const res = await call('POST', '/api/vendors/become', { actor, body: { businessName } });
  if (res.statusCode !== 201) throw new Error(`onboarding failed ${res.statusCode}: ${res.body}`);
  if (opts.withContact !== false) {
    const upd = await call('PUT', '/api/vendors/me', { actor, body: TEST_CONTACT });
    if (upd.statusCode !== 200) throw new Error(`contact update failed ${upd.statusCode}: ${upd.body}`);
  }
  return { ...actor, vendorId: json(res).data.id as string };
}

export async function makeAdmin(): Promise<Actor> {
  const actor = await signUp({ name: 'Admin Person' });
  await db.update(users).set({ role: 'admin' }).where(eq(users.id, actor.userId));
  return actor;
}

let categoryId: string | undefined;
export async function ensureCategory(): Promise<string> {
  if (categoryId) return categoryId;
  const admin = await makeAdmin();
  const res = await call('POST', '/api/categories', { actor: admin, body: { name: `Venues ${randomUUID().slice(0, 6)}` } });
  if (res.statusCode !== 201) throw new Error(`category failed: ${res.body}`);
  categoryId = json(res).data.id as string;
  return categoryId;
}

/** Create and publish a listing for `vendor`. */
export async function makeListing(vendor: Actor): Promise<string> {
  const cat = await ensureCategory();
  const res = await call('POST', '/api/listings', {
    actor: vendor,
    body: {
      categoryId: cat, title: 'Garden Wedding Venue', description: 'A lovely garden venue for weddings and events in Karen.',
      location: { county: 'Nairobi', area: 'Karen' }, pricingType: 'per_day', price: 50000,
      photos: ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg'],
    },
  });
  if (res.statusCode !== 201) throw new Error(`listing failed ${res.statusCode}: ${res.body}`);
  const id = json(res).data.id as string;
  const pub = await call('PATCH', `/api/listings/${id}/status`, { actor: vendor, body: { status: 'active' } });
  if (pub.statusCode !== 200) throw new Error(`publish failed ${pub.statusCode}: ${pub.body}`);
  return id;
}

/** Calendar date `days` from today (Nairobi). */
export function dayFromToday(days: number): string {
  const d = new Date(`${todayInNairobi()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function requestBooking(customer: Actor, listingId: string, start: number, end: number) {
  return call('POST', '/api/bookings', { actor: customer, body: { listingId, startDate: dayFromToday(start), endDate: dayFromToday(end), guests: 50 } });
}

/** End a vendor's trial now (shifts the trial window into the past). */
export async function endTrial(vendorId: string): Promise<void> {
  const ended = new Date(Date.now() - 60_000);
  const started = new Date(ended);
  started.setUTCMonth(started.getUTCMonth() - 1);
  await db.update(vendorSubscriptions).set({ trialEndsAt: ended, trialStartedAt: started }).where(eq(vendorSubscriptions.vendorId, vendorId));
}

/** Move a row's timestamps into the past ("time travel" without mocking clocks). */
export async function execSql(query: ReturnType<typeof sql>): Promise<void> {
  await db.execute(query);
}

export { db, memoryMailer };
