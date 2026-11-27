// Better Auth behind the frontend's same-origin /api proxy: BETTER_AUTH_URL is the public
// frontend origin (here the test frontend http://localhost:5173, also in CORS_ORIGINS).
import { afterAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const saved = vi.hoisted(() => {
  const keys = ['BETTER_AUTH_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const;
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.BETTER_AUTH_URL = 'http://localhost:5173';
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  return before;
});

import { ORIGIN, call, json, signUp } from '../helpers/app.js';

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const setCookies = (h: string | string[] | undefined) => (Array.isArray(h) ? h : h ? [h] : []);

describe('Better Auth behind the frontend /api proxy', () => {
  it('Google sign-in sends users back through the frontend origin (redirect_uri on BETTER_AUTH_URL)', async () => {
    const res = await call('POST', '/api/auth/sign-in/social', { body: { provider: 'google', callbackURL: '/store' } });
    expect(res.statusCode).toBe(200);
    const url = new URL(json<{ url: string }>(res).url);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/callback/google`);
    // The OAuth state cookie is host-only, so it lands on the frontend origin via the proxy.
    const cookies = setCookies(res.headers['set-cookie']);
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) expect(c).not.toMatch(/;\s*domain=/i);
  });

  it('email sign-in returns a host-only, HttpOnly session cookie usable by the frontend origin', async () => {
    const actor = await signUp();
    const res = await call('POST', '/api/auth/sign-in/email', { body: { email: actor.email, password: 'correct-horse-battery-staple' } });
    expect(res.statusCode).toBe(200);
    const session = setCookies(res.headers['set-cookie']).find((c) => /session_token=/.test(c));
    expect(session).toBeTruthy();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Path=\//i);
    expect(session).not.toMatch(/;\s*domain=/i);
    // The cookie authenticates API calls.
    const cookie = session!.split(';')[0]!;
    expect(json(await call('GET', '/api/users/me', { headers: { cookie } })).data.email).toBe(actor.email);
  });

  it('requests from an origin outside CORS_ORIGINS are refused by Better Auth', async () => {
    const res = await call('POST', '/api/auth/sign-in/email', {
      headers: { origin: 'https://evil.example', cookie: 'better-auth.session_token=x' },
      body: { email: `x-${randomUUID()}@test.linkmart.local`, password: 'whatever-123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a callbackURL on an untrusted origin is rejected (no open redirect)', async () => {
    const res = await call('POST', '/api/auth/sign-in/social', { body: { provider: 'google', callbackURL: 'https://evil.example/steal' } });
    expect(res.statusCode).toBe(403);
  });
});
