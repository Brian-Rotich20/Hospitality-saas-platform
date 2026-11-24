// Rate limiting with the real Redis store, rate limits switched ON for this file, and the
// API configured to trust a proxy subnet (the Next.js /api proxy in production).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';

const saved = vi.hoisted(() => {
  const keys = ['RATE_LIMIT_ENABLED', 'TRUST_PROXY'] as const;
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.RATE_LIMIT_ENABLED = 'true';
  process.env.TRUST_PROXY = '10.0.0.0/8';
  return before;
});

import { ORIGIN, getApp, json, makeCustomer, makeVendor, type Actor } from '../helpers/app.js';

const PROXY = '10.0.0.7';            // inside TRUST_PROXY
const UNTRUSTED_PEER = '198.51.100.20'; // a client talking to the API directly

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

interface Req { method: 'GET' | 'POST'; url: string; body?: unknown; cookie?: string; clientIp?: string; peer?: string; forwardedFor?: string }

async function send(r: Req): Promise<LightMyRequestResponse> {
  const app = await getApp();
  const forwarded = r.forwardedFor ?? r.clientIp;
  return app.inject({
    method: r.method, url: r.url, remoteAddress: r.peer ?? PROXY,
    headers: {
      origin: ORIGIN,
      ...(forwarded ? { 'x-forwarded-for': forwarded } : {}),
      ...(r.cookie ? { cookie: r.cookie } : {}),
      ...(r.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(r.body !== undefined ? { payload: JSON.stringify(r.body) } : {}),
  });
}

async function burst(n: number, r: Req | ((i: number) => Req)): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await send(typeof r === 'function' ? r(i) : r)).statusCode);
  return statuses;
}

const signIn = (ip: string, extra: Partial<Req> = {}): Req => ({
  method: 'POST', url: '/api/auth/sign-in/email', clientIp: ip, body: { email: `nobody-${randomUUID()}@test.linkmart.local`, password: 'wrong-password-123' }, ...extra,
});

describe('anonymous requests are limited by the real client IP', () => {
  it('global limit: 300/min per client behind the trusted proxy; other clients are unaffected', async () => {
    const statuses = await burst(301, { method: 'GET', url: '/api/categories', clientIp: '203.0.113.10' });
    expect(statuses.slice(0, 300).every((s) => s === 200)).toBe(true);
    const limited = await send({ method: 'GET', url: '/api/categories', clientIp: '203.0.113.10' });
    expect(statuses[300]).toBe(429);
    expect(json(limited)).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    expect((await send({ method: 'GET', url: '/api/categories', clientIp: '203.0.113.11' })).statusCode).toBe(200);
  });

  it('sign-in: 30/min per client IP through the proxy', async () => {
    const statuses = await burst(31, signIn('203.0.113.20'));
    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect((await send(signIn('203.0.113.21'))).statusCode).not.toBe(429);
  });

  it('a forwarded header from an untrusted peer is ignored: the peer address is the key', async () => {
    // Every request claims to be a different client; none of those claims is trusted.
    const statuses = await burst(31, (i) => signIn(`192.0.2.${i + 1}`, { peer: UNTRUSTED_PEER }));
    expect(statuses[30]).toBe(429);
  });

  it('password-reset requests: 5 per 15 minutes per client IP', async () => {
    const reset = (ip: string): Req => ({ method: 'POST', url: '/api/auth/request-password-reset', clientIp: ip, body: { email: `nobody-${randomUUID()}@test.linkmart.local` } });
    const statuses = await burst(6, reset('203.0.113.30'));
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect((await send(reset('203.0.113.31'))).statusCode).toBe(200);
  });
});

describe('signed-in requests are limited per user, independent of IP', () => {
  let a: Actor;
  let b: Actor;
  let vendor: Actor & { vendorId: string };

  beforeAll(async () => {
    [a, b] = [await makeCustomer(), await makeCustomer()];
    vendor = await makeVendor('Rate Limit Vendor');
  });

  // An invalid body is rejected (422) after the limiter has counted the request, so no
  // bookings or payments are created while exhausting the limits.
  const badBooking = (actor: Actor, ip: string): Req => ({ method: 'POST', url: '/api/bookings', cookie: actor.cookie, clientIp: ip, body: { listingId: 'not-a-uuid' } });

  it('booking requests: 10/min per user; a second user on the same IP is not affected', async () => {
    const statuses = await burst(11, badBooking(a, '203.0.113.40'));
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await send(badBooking(b, '203.0.113.40'))).statusCode).toBe(422);
  });

  it('a user\'s limit follows the account, not the address', async () => {
    expect((await send(badBooking(a, '203.0.113.99'))).statusCode).toBe(429);
  });

  it('subscription payment starts: 5/min per vendor', async () => {
    const pay: Req = { method: 'POST', url: '/api/subscriptions/me/payments', cookie: vendor.cookie, clientIp: '203.0.113.50', body: { provider: 'bitcoin' } };
    const statuses = await burst(6, pay);
    expect(statuses.slice(0, 5).every((s) => s === 422)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('an invalid session cookie is treated as anonymous (keyed by IP), not as a user', async () => {
    const statuses = await burst(31, signIn('203.0.113.60', { cookie: 'better-auth.session_token=forged.value' }));
    expect(statuses[30]).toBe(429);
    expect((await send(signIn('203.0.113.61', { cookie: 'better-auth.session_token=forged.value' }))).statusCode).not.toBe(429);
  });
});
