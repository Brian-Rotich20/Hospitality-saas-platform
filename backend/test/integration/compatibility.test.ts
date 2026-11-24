// Backend-to-frontend compatibility fixes: multipart field order for uploads, response
// types (ratings numbers, prices strings), and the vendor email-verification policy.
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { call, db, getApp, json, makeCustomer, makeListing, makeVendor, requestBooking, signUp, verifyEmail, type Actor } from '../helpers/app.js';
import { setStorage, type Storage } from '../../src/platform/storage/index.js';
import { bookingsService } from '../../src/modules/bookings/service.js';
import { uploads } from '../../src/platform/database/schema/platform.js';
import { bookings } from '../../src/platform/database/schema/bookings.js';
import { users } from '../../src/platform/database/schema/users.js';
import { vendors } from '../../src/platform/database/schema/vendors.js';

class FakeStorage implements Storage {
  stored = 0;
  putPublicImage(buffer: Buffer, folder: string, key: string, mimeType: string) {
    this.stored++;
    return Promise.resolve({ publicId: `${folder}/${key}`, url: `https://img.test/${folder}/${key}.webp`, bytes: buffer.length, mimeType, width: 4, height: 4 });
  }
  delete() { return Promise.resolve(); }
}

type Part = { field: string; value: string } | { file: Buffer; filename: string; type: string };
function multipart(parts: Part[]) {
  const boundary = `----lm${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if ('field' in p) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.field}"\r\n\r\n${p.value}\r\n`));
    else chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`), p.file, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('uploads: uploadType is required and must precede the file', () => {
  const storage = new FakeStorage();
  let png: Buffer;
  let customer: Actor;
  const file = () => ({ file: png, filename: 'a.png', type: 'image/png' });
  const upload = (parts: Part[], url = '/api/upload/image', actor: Actor = customer) => {
    const form = multipart(parts);
    return call('POST', url, { actor, body: form.body, headers: form.headers });
  };
  const uploadCount = async (actor: Actor) => (await db.select().from(uploads).where(eq(uploads.ownerUserId, actor.userId))).length;

  beforeAll(async () => {
    setStorage(storage);
    png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer();
    customer = await makeCustomer();
  });

  it('file sent before uploadType: 422, nothing stored', async () => {
    const before = storage.stored;
    const res = await upload([file(), { field: 'uploadType', value: 'profile_photo' }]);
    expect(res.statusCode).toBe(422);
    expect(json(res)).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: '/uploadType' }] });
    expect(storage.stored).toBe(before);
    expect(await uploadCount(customer)).toBe(0);
  });

  it('uploadType missing: 422, nothing stored', async () => {
    const before = storage.stored;
    const res = await upload([file()]);
    expect(res.statusCode).toBe(422);
    expect(json(res).details[0].path).toBe('/uploadType');
    expect(storage.stored).toBe(before);
  });

  it('unknown uploadType: 422', async () => {
    expect((await upload([{ field: 'uploadType', value: 'kyc_document' }, file()])).statusCode).toBe(422);
  });

  it('uploadType first: stored with the requested purpose (customers can upload profile photos)', async () => {
    const res = await upload([{ field: 'uploadType', value: 'profile_photo' }, file()]);
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(uploads).where(eq(uploads.publicId, json(res).data.publicId as string));
    expect(row).toMatchObject({ purpose: 'profile_photo', ownerUserId: customer.userId });
  });

  it('role rules are unchanged: customers still cannot upload listing photos; vendors can, also in bulk', async () => {
    expect((await upload([{ field: 'uploadType', value: 'listing_photo' }, file()])).statusCode).toBe(403);
    const vendor = await makeVendor('Upload Order Co');
    const res = await upload([{ field: 'uploadType', value: 'listing_photo' }, file(), file()], '/api/upload/images', vendor);
    expect(res.statusCode).toBe(201);
    expect(json(res).data).toHaveLength(2);
  });
});

describe('response types: ratings are numbers, prices are decimal strings', () => {
  let vendor: Actor & { vendorId: string };
  let customer: Actor;
  let listingId: string;

  beforeAll(async () => {
    vendor = await makeVendor('Typed Venue Co');
    customer = await makeCustomer();
    listingId = await makeListing(vendor);
  });

  it('a listing with no reviews: rating null, prices as strings', async () => {
    const d = json(await call('GET', `/api/listings/${listingId}`)).data;
    expect(d.rating).toBeNull();
    expect(d.reviewCount).toBe(0);
    expect(d.price).toBe('50000.00');
    expect(d.minPrice).toBeNull();
    // Fields outside the typed contract are still returned unchanged.
    expect(d.vendor).toMatchObject({ id: vendor.vendorId });
    expect(d.category).toBeTruthy();
    expect(Array.isArray(d.photos)).toBe(true);
  });

  it('after a review: rating is a number on detail, search, featured and the review stats', async () => {
    const bookingId = json(await requestBooking(customer, listingId, 400, 401)).data.id as string;
    expect((await call('PUT', `/api/bookings/${bookingId}/accept`, { actor: vendor })).statusCode).toBe(200);
    await db.update(bookings).set({ startDate: new Date('2020-01-01T00:00:00Z'), endDate: new Date('2020-01-02T00:00:00Z') }).where(eq(bookings.id, bookingId));
    await bookingsService.autoComplete();
    const review = await call('POST', '/api/reviews', { actor: customer, body: { bookingId, rating: 4, body: 'Lovely garden, great service throughout.' } });
    expect(review.statusCode).toBe(201);

    const detail = json(await call('GET', `/api/listings/${listingId}`)).data;
    expect(detail.rating).toBe(4);
    expect(typeof detail.rating).toBe('number');
    expect(detail.reviewCount).toBe(1);
    expect(typeof detail.price).toBe('string');

    const search = json(await call('GET', '/api/listings?limit=100'));
    expect(typeof search.total).toBe('number');
    const found = (search.data as { id: string; rating: unknown }[]).find((l) => l.id === listingId);
    expect(found?.rating).toBe(4);

    const reviews = json(await call('GET', `/api/reviews/listing/${listingId}`)).data;
    expect(reviews.stats.average).toBe(4);
    expect(reviews.reviews[0].rating).toBe(4);

    const mine = json(await call('GET', '/api/listings/me', { actor: vendor })).data as { id: string; rating: unknown }[];
    expect(mine.find((l) => l.id === listingId)?.rating).toBe(4);
  });

  it('write responses use the same types', async () => {
    const res = await call('PUT', `/api/listings/${listingId}`, { actor: vendor, body: { price: 61000 } });
    expect(res.statusCode).toBe(200);
    expect(json(res).data).toMatchObject({ price: '61000.00', rating: 4 });
  });

  it('the OpenAPI document declares the types', async () => {
    const doc = (await getApp()).swagger() as unknown as { paths: Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: { properties: Record<string, unknown> } }> }> }>> };
    const schema = doc.paths['/api/listings/{id}']!.get!.responses['200']!.content['application/json']!.schema;
    const data = schema.properties.data as { properties: Record<string, unknown> };
    expect(JSON.stringify(data.properties.rating)).toMatch(/number/);
    expect(JSON.stringify(data.properties.price)).toMatch(/string/);
  });
});

describe('vendor onboarding requires a verified email', () => {
  it('an unverified user gets 403 EMAIL_NOT_VERIFIED and nothing changes', async () => {
    const user = await signUp({ verified: false });
    const res = await call('POST', '/api/vendors/become', { actor: user, body: { businessName: 'Too Early Co' } });
    expect(res.statusCode).toBe(403);
    expect(json(res)).toMatchObject({ success: false, code: 'EMAIL_NOT_VERIFIED' });
    expect((await db.query.users.findFirst({ where: eq(users.id, user.userId), columns: { role: true } }))!.role).toBe('customer');
    expect(await db.query.vendors.findFirst({ where: eq(vendors.userId, user.userId) })).toBeUndefined();
  });

  it('the same user can onboard right after verifying', async () => {
    const user = await signUp({ verified: false });
    await verifyEmail(user);
    expect((await call('POST', '/api/vendors/become', { actor: user, body: {} })).statusCode).toBe(201);
  });
});

