// Vendor business profile and public contact: CRUD through PUT/GET /api/vendors/me,
// validation and normalisation, ownership, separation from the login email, exposure on
// listings, and the publish rule (complete contact required to publish).
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  call, db, ensureCategory, json, makeCustomer, makeListing, makeVendor, TEST_CONTACT, type Actor,
} from '../helpers/app.js';
import { vendors } from '../../src/platform/database/schema/vendors.js';
import { normalisePhone } from '../../src/modules/vendors/contact.js';

async function draftListing(actor: Actor) {
  const cat = await ensureCategory();
  const res = await call('POST', '/api/listings', {
    actor,
    body: {
      categoryId: cat, title: 'Lakeside Garden Hall', description: 'A spacious garden hall for weddings and corporate events.',
      location: { county: 'Nairobi', area: 'Karen' }, pricingType: 'per_day', price: 40000,
      photos: ['https://img.test/a.jpg', 'https://img.test/b.jpg', 'https://img.test/c.jpg'],
    },
  });
  expect(res.statusCode).toBe(201);
  return json(res).data.id as string;
}

describe('phone normalisation', () => {
  it('accepts Kenyan local and international formats and returns E.164', () => {
    expect(normalisePhone('0712 345 678')).toBe('+254712345678');
    expect(normalisePhone('0110-123-456')).toBe('+254110123456');
    expect(normalisePhone('020 123 4567')).toBe('+254201234567');
    expect(normalisePhone('254712345678')).toBe('+254712345678');
    expect(normalisePhone('+254 (712) 345.678')).toBe('+254712345678');
    expect(normalisePhone('+44 20 7946 0958')).toBe('+442079460958');
  });
  it('rejects malformed numbers', () => {
    for (const bad of ['12345', '0712', '+0712345678', 'call me', '07123456789', '+1234567']) expect(normalisePhone(bad)).toBeNull();
  });
});

describe('vendor business profile', () => {
  it('returns and updates the business contact, normalising numbers', async () => {
    const v = await makeVendor('Contact Co', { withContact: false });
    const before = json(await call('GET', '/api/vendors/me', { actor: v })).data;
    expect(before).toMatchObject({ businessEmail: null, whatsappNumber: null });
    expect(before.contactMissing).toEqual(expect.arrayContaining(['businessEmail', 'whatsappNumber']));

    const res = await call('PUT', '/api/vendors/me', { actor: v, body: { businessEmail: '  Bookings@Contact.CO.KE ', phoneNumber: '0712 345 678', whatsappNumber: '+44 20 7946 0958', businessName: 'Contact Company' } });
    expect(res.statusCode).toBe(200);
    expect(json(res).data).toMatchObject({ businessEmail: 'bookings@contact.co.ke', phoneNumber: '+254712345678', whatsappNumber: '+442079460958', businessName: 'Contact Company' });

    const after = json(await call('GET', '/api/vendors/me', { actor: v })).data;
    expect(after.contactMissing).toEqual([]);
  });

  it('rejects invalid email and phone numbers with field errors', async () => {
    const v = await makeVendor('Invalid Co');
    const res = await call('PUT', '/api/vendors/me', { actor: v, body: { businessEmail: 'not-an-email', phoneNumber: '12345', whatsappNumber: 'call me' } });
    expect(res.statusCode).toBe(422);
    const paths = (json(res).details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['/businessEmail', '/phoneNumber', '/whatsappNumber']));
    // Nothing was changed.
    const me = json(await call('GET', '/api/vendors/me', { actor: v })).data;
    expect(me.businessEmail).toBe(TEST_CONTACT.businessEmail);
  });

  it('clears a contact field with null or an empty string', async () => {
    const v = await makeVendor('Clear Co');
    const res = await call('PUT', '/api/vendors/me', { actor: v, body: { whatsappNumber: null, businessEmail: '' } });
    expect(res.statusCode).toBe(200);
    expect(json(res).data).toMatchObject({ whatsappNumber: null, businessEmail: null });
  });

  it('never changes the login email', async () => {
    const v = await makeVendor('Login Co');
    await call('PUT', '/api/vendors/me', { actor: v, body: { businessEmail: 'different@business.test' } });
    const user = json(await call('GET', '/api/users/me', { actor: v })).data;
    expect(user.email).toBe(v.email);
  });

  it('only ever updates the caller’s own vendor', async () => {
    const a = await makeVendor('Owner A');
    const b = await makeVendor('Owner B');
    // Identifiers in the body are not part of the contract and are ignored.
    const res = await call('PUT', '/api/vendors/me', { actor: a, body: { id: b.vendorId, vendorId: b.vendorId, userId: b.userId, businessEmail: 'hijack@a.test' } });
    expect(res.statusCode).toBe(200);
    const rowB = await db.query.vendors.findFirst({ where: eq(vendors.id, b.vendorId) });
    expect(rowB?.businessEmail).toBe(TEST_CONTACT.businessEmail);
    const rowA = await db.query.vendors.findFirst({ where: eq(vendors.id, a.vendorId) });
    expect(rowA?.businessEmail).toBe('hijack@a.test');
  });

  it('is vendor-only', async () => {
    const customer = await makeCustomer();
    expect((await call('GET', '/api/vendors/me', { actor: customer })).statusCode).toBe(403);
    expect((await call('PUT', '/api/vendors/me', { actor: customer, body: { businessEmail: 'x@y.test' } })).statusCode).toBe(403);
    expect((await call('PUT', '/api/vendors/me', { body: { businessEmail: 'x@y.test' } })).statusCode).toBe(401);
  });
});

describe('publishing requires a complete business contact', () => {
  it('rejects publishing with the missing fields, then allows it once completed', async () => {
    const v = await makeVendor('Incomplete Co', { withContact: false });
    const id = await draftListing(v);
    const rejected = await call('PATCH', `/api/listings/${id}/status`, { actor: v, body: { status: 'active' } });
    expect(rejected.statusCode).toBe(422);
    expect(json(rejected)).toMatchObject({ code: 'BUSINESS_CONTACT_REQUIRED' });
    expect(json(rejected).details.missing).toEqual(expect.arrayContaining(['businessEmail', 'whatsappNumber']));

    await call('PUT', '/api/vendors/me', { actor: v, body: TEST_CONTACT });
    const published = await call('PATCH', `/api/listings/${id}/status`, { actor: v, body: { status: 'active' } });
    expect(published.statusCode).toBe(200);
  });

  it('still lets a vendor pause a listing without contact details', async () => {
    const v = await makeVendor('Pause Co');
    const id = await makeListing(v);
    await call('PUT', '/api/vendors/me', { actor: v, body: { whatsappNumber: null } });
    expect((await call('PATCH', `/api/listings/${id}/status`, { actor: v, body: { status: 'paused' } })).statusCode).toBe(200);
  });

  it('keeps already-published listings live if the contact is later incomplete', async () => {
    const v = await makeVendor('Legacy Co');
    const id = await makeListing(v);
    await call('PUT', '/api/vendors/me', { actor: v, body: { businessEmail: null } });
    const res = await call('GET', `/api/listings/${id}`);
    expect(res.statusCode).toBe(200);
    expect(json(res).data.status).toBe('active');
  });
});

describe('public contact on listings and vendor pages', () => {
  it('exposes the business contact, never the login email or payout details', async () => {
    const v = await makeVendor('Public Co');
    const id = await makeListing(v);
    const listing = json(await call('GET', `/api/listings/${id}`)).data;
    expect(listing.vendor).toMatchObject({
      businessEmail: TEST_CONTACT.businessEmail, phoneNumber: '+254712345678', whatsappNumber: '+254712345679',
    });
    const text = JSON.stringify(listing);
    expect(text).not.toContain(v.email);
    expect(text).not.toContain('payout');

    const search = json(await call('GET', '/api/listings?limit=100')).data as { id: string; vendor: Record<string, unknown> }[];
    expect(search.find((l) => l.id === id)?.vendor).toMatchObject({ whatsappNumber: '+254712345679' });

    const pub = json(await call('GET', `/api/vendors/${v.vendorId}`)).data;
    expect(pub).toMatchObject({ businessEmail: TEST_CONTACT.businessEmail, whatsappNumber: '+254712345679' });
    expect(JSON.stringify(pub)).not.toContain(v.email);
  });

  it('reflects contact changes on every listing of the vendor', async () => {
    const v = await makeVendor('Many Listings Co');
    const one = await makeListing(v);
    const two = await makeListing(v);
    await call('PUT', '/api/vendors/me', { actor: v, body: { businessEmail: 'new@many.test' } });
    for (const id of [one, two]) {
      expect(json(await call('GET', `/api/listings/${id}`)).data.vendor.businessEmail).toBe('new@many.test');
    }
  });
});
