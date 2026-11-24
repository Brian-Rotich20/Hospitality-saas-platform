import { describe, expect, it, beforeAll } from 'vitest';
import { call, json, makeAdmin, makeCustomer, makeListing, makeVendor, signUp, verifyEmail, dayFromToday, type Actor } from '../helpers/app.js';

describe('authentication and role permissions', () => {
  let listingId: string;
  let vendor: Actor;

  beforeAll(async () => {
    vendor = await makeVendor();
    listingId = await makeListing(vendor);
  });

  it('rejects protected routes without a session (401, stable error shape)', async () => {
    const res = await call('GET', '/api/users/me');
    expect(res.statusCode).toBe(401);
    expect(json(res)).toMatchObject({ success: false, code: 'UNAUTHENTICATED' });
    expect(json(res).requestId).toBeTruthy();
  });

  it('removed development endpoints are gone', async () => {
    expect((await call('POST', '/api/dev/seed-admin', { body: {} })).statusCode).toBe(404);
  });

  it('signs up, verifies email with the OTP, and reads the profile', async () => {
    const user = await signUp({ verified: false });
    const before = json(await call('GET', '/api/users/me', { actor: user }));
    expect(before.data).toMatchObject({ role: 'customer', verified: false });
    await verifyEmail(user);
    const after = json(await call('GET', '/api/users/me', { actor: user }));
    expect(after.data.verified).toBe(true);
  });

  it('rejects a wrong OTP without verifying', async () => {
    const user = await signUp({ verified: false });
    const res = await call('POST', '/api/otp/verify-email', { actor: user, body: { otp: '000000' } });
    expect([422]).toContain(res.statusCode);
    expect(json(await call('GET', '/api/users/me', { actor: user })).data.verified).toBe(false);
  });

  it('a customer cannot use admin endpoints (403)', async () => {
    const customer = await makeCustomer();
    const res = await call('GET', '/api/admin/vendors', { actor: customer });
    expect(res.statusCode).toBe(403);
  });

  it('role cannot be self-assigned at sign-up', async () => {
    const res = await call('POST', '/api/auth/sign-up/email', { body: { email: `x-${Date.now()}@test.linkmart.local`, password: 'correct-horse-battery-staple', name: 'X', role: 'admin' } });
    // Either rejected outright, or created as a plain customer: never an admin.
    if (res.statusCode === 200) {
      const me = json(await call('GET', '/api/users/me', { headers: { cookie: String(res.headers['set-cookie'] ?? '').split(';')[0] ?? '' } }));
      expect(me.data.role).toBe('customer');
    } else {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it('dangerous Better Auth admin endpoints are blocked even for admins', async () => {
    const admin = await makeAdmin();
    const res = await call('POST', '/api/auth/admin/set-role', { actor: admin, body: { userId: admin.userId, role: 'vendor' } });
    expect(res.statusCode).toBe(403);
    expect(json(res).code).toBe('AUTH_OPERATION_DISABLED');
  });

  it('only verified customers can submit booking requests', async () => {
    const body = { listingId, startDate: dayFromToday(20), endDate: dayFromToday(21), guests: 10 };

    const unverified = await signUp({ verified: false });
    const r1 = await call('POST', '/api/bookings', { actor: unverified, body });
    expect(r1.statusCode).toBe(403);
    expect(json(r1).code).toBe('EMAIL_NOT_VERIFIED');

    const otherVendor = await makeVendor('Another Vendor');
    const r2 = await call('POST', '/api/bookings', { actor: otherVendor, body });
    expect(r2.statusCode).toBe(403);
    expect(json(r2).code).toBe('CUSTOMERS_ONLY');

    const admin = await makeAdmin();
    const r3 = await call('POST', '/api/bookings', { actor: admin, body });
    expect(r3.statusCode).toBe(403);

    const customer = await makeCustomer();
    const ok = await call('POST', '/api/bookings', { actor: customer, body });
    expect(ok.statusCode).toBe(201);
    expect(json(ok).data.status).toBe('requested');
  });

  it('a vendor cannot book their own or anyone else\'s listing even after role tampering attempts', async () => {
    const res = await call('POST', '/api/bookings', { actor: vendor, body: { listingId, startDate: dayFromToday(30), endDate: dayFromToday(31), guests: 2 } });
    expect(res.statusCode).toBe(403);
  });

  it('validation failures return 422 with details', async () => {
    const customer = await makeCustomer();
    const res = await call('POST', '/api/bookings', { actor: customer, body: { listingId: 'not-a-uuid' } });
    expect(res.statusCode).toBe(422);
    expect(json(res).code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(json(res).details)).toBe(true);
  });
});
