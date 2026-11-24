// Phase 6: security regression suite. Every rule is tested from the outside, through the
// real HTTP stack: anonymous -> 401, wrong role -> 403 + code, other tenant -> 404.
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import {
  call, db, ensureCategory, json, makeAdmin, makeCustomer, makeListing, makeVendor, requestBooking, type Actor,
} from '../helpers/app.js';
import { setStorage, type Storage } from '../../src/platform/storage/index.js';
import { users } from '../../src/platform/database/schema/users.js';
import { vendorSubscriptions } from '../../src/platform/database/schema/subscriptions.js';
import { bookings } from '../../src/platform/database/schema/bookings.js';

type Vendor = Actor & { vendorId: string };
let admin: Actor;

class FakeStorage implements Storage {
  readonly deleted: string[] = [];
  putPublicImage(buffer: Buffer, folder: string, key: string, mimeType: string) {
    return Promise.resolve({ publicId: `${folder}/${key}`, url: `https://img.test/${folder}/${key}.webp`, bytes: buffer.length, mimeType, width: 4, height: 4 });
  }
  delete(publicId: string) { this.deleted.push(publicId); return Promise.resolve(); }
}

function multipart(fields: Record<string, string>, file: { filename: string; type: string; data: Buffer }) {
  const boundary = `----lmtest${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function draftListing(v: Actor): Promise<string> {
  const res = await call('POST', '/api/listings', {
    actor: v,
    body: {
      categoryId: await ensureCategory(), title: 'Private Draft Hall', description: 'A draft listing that must never be visible to anyone else.',
      location: { county: 'Nairobi', area: 'Westlands' }, pricingType: 'per_day', price: 30000,
      photos: ['https://img.test/a.jpg', 'https://img.test/b.jpg', 'https://img.test/c.jpg'],
    },
  });
  expect(res.statusCode).toBe(201);
  return json(res).data.id as string;
}

beforeAll(async () => {
  admin = await makeAdmin();
});

describe('administrative endpoints', () => {
  const adminPaths = [
    '/api/admin/vendors', '/api/admin/customers', '/api/admin/bookings', '/api/admin/subscriptions', '/api/admin/subscriptions/plans',
    '/api/admin/subscriptions/unenrolled', '/api/admin/payments', '/api/admin/payments/provider-events', '/api/admin/messages/reports',
    '/api/admin/operations/health', '/api/admin/operations/audit',
  ];

  it('every admin listing rejects anonymous (401), customers and vendors (403), and serves admins', async () => {
    const customer = await makeCustomer();
    const vendor = await makeVendor('Admin Probe Co');
    for (const path of adminPaths) {
      expect({ path, status: (await call('GET', path)).statusCode }).toEqual({ path, status: 401 });
      expect({ path, status: (await call('GET', path, { actor: customer })).statusCode }).toEqual({ path, status: 403 });
      expect({ path, status: (await call('GET', path, { actor: vendor })).statusCode }).toEqual({ path, status: 403 });
      expect({ path, status: (await call('GET', path, { actor: admin })).statusCode }).toEqual({ path, status: 200 });
    }
  });

  it('admin write actions are rejected for non-admins', async () => {
    const vendor = await makeVendor('Self Reinstater');
    expect((await call('PUT', `/api/admin/vendors/${vendor.vendorId}/reinstate`, { actor: vendor, body: {} })).statusCode).toBe(403);
    expect((await call('POST', '/api/admin/subscriptions/plans', { actor: vendor, body: { code: 'free', name: 'Free', amountMinor: 100, currency: 'KES' } })).statusCode).toBe(403);
    expect((await call('POST', `/api/admin/subscriptions/unenrolled/${vendor.vendorId}/enrol`, { actor: vendor })).statusCode).toBe(403);
    expect((await call('POST', '/api/categories', { actor: vendor, body: { name: 'Sneaky' } })).statusCode).toBe(403);
  });
});

describe('authentication and roles', () => {
  it('a profile update cannot change the role', async () => {
    const c = await makeCustomer();
    const res = await call('PATCH', '/api/users/me', { actor: c, body: { fullName: 'Still Customer', role: 'admin' } });
    expect(res.statusCode).toBe(200);
    expect((await db.query.users.findFirst({ where: eq(users.id, c.userId), columns: { role: true } }))!.role).toBe('customer');
  });

  it('a banned user\'s existing session is rejected', async () => {
    const c = await makeCustomer();
    expect((await call('GET', '/api/users/me', { actor: c })).statusCode).toBe(200);
    await db.update(users).set({ banned: true }).where(eq(users.id, c.userId));
    expect((await call('GET', '/api/users/me', { actor: c })).statusCode).toBe(401);
  });
});

describe('cross-vendor isolation', () => {
  let owner: Vendor;
  let other: Vendor;
  let draftId: string;
  let liveId: string;

  beforeAll(async () => {
    owner = await makeVendor('Owner Co');
    other = await makeVendor('Rival Co');
    draftId = await draftListing(owner);
    liveId = await makeListing(owner);
  });

  it('drafts are visible to their owner only', async () => {
    expect((await call('GET', `/api/listings/${draftId}`, { actor: owner })).statusCode).toBe(200);
    expect((await call('GET', `/api/listings/${draftId}`)).statusCode).toBe(404);
    expect((await call('GET', `/api/listings/${draftId}`, { actor: other })).statusCode).toBe(404);
    expect((await call('GET', `/api/listings/${draftId}`, { actor: await makeCustomer() })).statusCode).toBe(404);
  });

  it('another vendor cannot edit, publish, delete or block dates on a listing (404, no existence oracle)', async () => {
    expect((await call('PUT', `/api/listings/${liveId}`, { actor: other, body: { title: 'Hijacked listing title' } })).statusCode).toBe(404);
    expect((await call('PATCH', `/api/listings/${draftId}/status`, { actor: other, body: { status: 'active' } })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/listings/${liveId}`, { actor: other })).statusCode).toBe(404);
    expect((await call('POST', `/api/listings/${liveId}/block`, { actor: other, body: { dates: ['2030-01-01'] } })).statusCode).toBe(404);
    expect((await call('POST', `/api/listings/${liveId}/unblock`, { actor: other, body: { dates: ['2030-01-01'] } })).statusCode).toBe(404);
    expect((await call('GET', `/api/listings/${liveId}`)).statusCode).toBe(200);
  });

  it('a vendor\'s booking list never includes another vendor\'s bookings', async () => {
    const c = await makeCustomer();
    const id = json(await requestBooking(c, liveId, 300, 301)).data.id as string;
    const mine = json(await call('GET', '/api/bookings/vendor', { actor: other })).data as { id: string }[];
    expect(mine.some((b) => b.id === id)).toBe(false);
    expect((await call('GET', `/api/bookings/${id}`, { actor: other })).statusCode).toBe(404);
    expect((await call('GET', `/api/bookings/${id}/events`, { actor: other })).statusCode).toBe(404);
  });
});

describe('suspended vendors (admin moderation)', () => {
  it('cannot create listings or book as a customer, keep billing access, and accepted bookings are unaffected', async () => {
    const v = await makeVendor('Suspend Me Co');
    const listingId = await makeListing(v);
    const c = await makeCustomer();
    const bookingId = json(await requestBooking(c, listingId, 320, 321)).data.id as string;
    expect((await call('PUT', `/api/bookings/${bookingId}/accept`, { actor: v })).statusCode).toBe(200);

    expect((await call('PUT', `/api/admin/vendors/${v.vendorId}/suspend`, { actor: admin, body: { reason: 'Policy review in progress' } })).statusCode).toBe(200);
    const create = await call('POST', '/api/listings', { actor: v, body: {} });
    expect(create.statusCode).toBe(403);
    expect(json(create).code).toBe('VENDOR_SUSPENDED');
    const book = await call('POST', '/api/bookings', { actor: v, body: { listingId, startDate: '2031-01-01', endDate: '2031-01-02', guests: 2 } });
    expect(book.statusCode).toBe(403);
    expect(json(book).code).toBe('CUSTOMERS_ONLY');
    expect((await call('GET', '/api/subscriptions/me', { actor: v })).statusCode).toBe(200);
    expect(json(await call('GET', `/api/bookings/${bookingId}`, { actor: c })).data.status).toBe('accepted');
    expect((await db.query.users.findFirst({ where: eq(users.id, v.userId), columns: { role: true } }))!.role).toBe('vendor');

    expect((await call('PUT', `/api/admin/vendors/${v.vendorId}/reinstate`, { actor: admin, body: {} })).statusCode).toBe(200);
    expect((await call('GET', `/api/listings/${listingId}`)).statusCode).toBe(200);
  });
});

describe('bookings are independent of any payment', () => {
  it('a trialing vendor with no payments accepts; later subscription problems never undo the acceptance', async () => {
    const v = await makeVendor('No Payment Needed Co');
    const listingId = await makeListing(v);
    const c = await makeCustomer();
    const id = json(await requestBooking(c, listingId, 340, 341)).data.id as string;
    const acc = await call('PUT', `/api/bookings/${id}/accept`, { actor: v });
    expect(acc.statusCode).toBe(200);
    expect(json(acc).data.status).toBe('accepted');
    expect(JSON.stringify(json(acc).data)).not.toMatch(/"(amount|totalAmount|paymentStatus|platformFee|vat)"/);

    await db.update(vendorSubscriptions).set({ status: 'suspended', suspendedAt: new Date() }).where(eq(vendorSubscriptions.vendorId, v.vendorId));
    const row = await db.query.bookings.findFirst({ where: eq(bookings.id, id) });
    expect(row?.status).toBe('accepted');
    expect(json(await call('GET', `/api/bookings/${id}`, { actor: c })).data.status).toBe('accepted');
    const conv = json(await call('GET', `/api/conversations/by-booking/${id}`, { actor: c })).data as { id: string };
    expect((await call('POST', `/api/conversations/${conv.id}/messages`, { actor: c, body: { body: 'See you on the day, thanks!' } })).statusCode).toBe(201);
  });
});

describe('uploads', () => {
  const storage = new FakeStorage();
  let png: Buffer;

  beforeAll(async () => {
    setStorage(storage);
    png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#cc3300' } }).png().toBuffer();
  });

  it('detects the type from the bytes, not the declared content type', async () => {
    const v = await makeVendor('Upload Co');
    const fake = multipart({ uploadType: 'listing_photo' }, { filename: 'x.png', type: 'image/png', data: Buffer.from('<?php echo "not an image"; ?>') });
    const res = await call('POST', '/api/upload/image', { actor: v, body: fake.body, headers: fake.headers });
    expect(res.statusCode).toBe(422);
  });

  it('customers cannot upload listing photos; files can be deleted by their owner (or an admin) only', async () => {
    const c = await makeCustomer();
    const asCustomer = multipart({ uploadType: 'listing_photo' }, { filename: 'p.png', type: 'image/png', data: png });
    const denied = await call('POST', '/api/upload/image', { actor: c, body: asCustomer.body, headers: asCustomer.headers });
    expect(denied.statusCode).toBe(403);

    const v = await makeVendor('Owner Upload Co');
    const form = multipart({ uploadType: 'listing_photo' }, { filename: 'p.png', type: 'image/png', data: png });
    const up = await call('POST', '/api/upload/image', { actor: v, body: form.body, headers: form.headers });
    expect(up.statusCode).toBe(201);
    expect(json(up).data.mimeType).toBe('image/webp');
    const publicId = json(up).data.publicId as string;

    const stranger = await makeVendor('Stranger Co');
    expect((await call('DELETE', '/api/upload/file', { actor: stranger, body: { publicId } })).statusCode).toBe(404);
    expect(storage.deleted).not.toContain(publicId);
    expect((await call('DELETE', '/api/upload/file', { actor: v, body: { publicId } })).statusCode).toBe(200);
    expect(storage.deleted).toContain(publicId);
    expect((await call('DELETE', '/api/upload/file', { actor: v, body: { publicId } })).statusCode).toBe(404);
  });
});

describe('input handling and error leakage', () => {
  it('malformed JSON, bad identifiers and unknown routes return the standard envelope without internals', async () => {
    const c = await makeCustomer();
    const bad = await call('POST', '/api/bookings', { actor: c, body: '{"listingId": ', headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad)).toMatchObject({ success: false });
    expect(bad.body).not.toMatch(/\bat \S+\.(js|ts):\d+|SyntaxError: /);

    const notUuid = await call('GET', '/api/bookings/not-a-uuid', { actor: c });
    expect(notUuid.statusCode).toBe(422);
    expect(json(notUuid).code).toBe('VALIDATION_FAILED');

    const missing = await call('GET', '/api/does-not-exist');
    expect(json(missing)).toMatchObject({ success: false, code: 'ROUTE_NOT_FOUND' });
    expect(json(missing).requestId).toBeTruthy();
  });

  it('search input is bound as a parameter (SQL injection attempts match nothing and break nothing)', async () => {
    for (const search of ["x' OR '1'='1", "'; DROP TABLE listings; --", '%_%\\']) {
      const res = await call('GET', `/api/listings?search=${encodeURIComponent(search)}`);
      expect(res.statusCode).toBe(200);
      expect(json(res).total).toBe(0);
    }
    expect((await call('GET', '/api/listings')).statusCode).toBe(200);
  });

  it('oversized and out-of-range inputs are rejected by validation', async () => {
    const c = await makeCustomer();
    expect((await call('GET', '/api/listings?limit=100000')).statusCode).toBe(422);
    expect((await call('PATCH', '/api/users/me', { actor: c, body: { fullName: 'x'.repeat(500) } })).statusCode).toBe(422);
  });

  it('responses carry basic hardening headers', async () => {
    const res = await call('GET', '/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });
});
