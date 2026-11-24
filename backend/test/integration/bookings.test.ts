import { beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { call, db, json, makeAdmin, makeCustomer, makeListing, makeVendor, requestBooking, dayFromToday, memoryMailer, type Actor } from '../helpers/app.js';
import { bookings } from '../../src/platform/database/schema/bookings.js';
import { outbox } from '../../src/platform/database/schema/platform.js';
import { bookingsService } from '../../src/modules/bookings/service.js';
import { getBookingsQueue } from '../../src/platform/queue/index.js';
import { dispatchOutbox } from '../../src/modules/notifications/dispatcher.js';

describe('booking requests (request-to-book, no platform payment)', () => {
  let vendor: Actor & { vendorId: string };
  let listingId: string;

  beforeAll(async () => {
    vendor = await makeVendor('Lifecycle Venue');
    listingId = await makeListing(vendor);
  });

  it('creates a REQUESTED booking with a 24h database deadline and schedules expiry', async () => {
    const customer = await makeCustomer();
    const res = await requestBooking(customer, listingId, 10, 11);
    expect(res.statusCode).toBe(201);
    const data = json(res).data;
    expect(data.status).toBe('requested');
    expect(data.paymentNote).toMatch(/directly between the customer and the vendor/);

    const row = await db.query.bookings.findFirst({ where: eq(bookings.id, data.id) });
    const hours = (row!.respondBy!.getTime() - row!.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    // No financial fields are written.
    expect(row!.totalAmount).toBeNull();
    expect(row!.platformFee).toBeNull();

    const job = await getBookingsQueue().getJob(`expire-${data.id}`);
    expect(job).toBeTruthy();
    expect(job!.opts.delay).toBeGreaterThan(23 * 3_600_000);
  });

  it('notifies the vendor of a new request through the outbox', async () => {
    const customer = await makeCustomer();
    const res = await requestBooking(customer, listingId, 40, 40);
    const id = json(res).data.id as string;
    const pending = await db.query.outbox.findFirst({ where: eq(outbox.dedupeKey, `booking-requested:${id}`) });
    expect(pending).toBeTruthy();
    await db.update(outbox).set({ availableAt: new Date(0) }).where(eq(outbox.id, pending!.id));
    while ((await dispatchOutbox(50)) > 0) { /* drain */ }
    expect(memoryMailer.sent.some((m) => m.to === vendor.email && m.tag === 'booking.requested')).toBe(true);
  });

  it('vendor accepts: status ACCEPTED, conversation opened, contacts shared', async () => {
    const customer = await makeCustomer();
    const id = json(await requestBooking(customer, listingId, 12, 13)).data.id as string;
    const res = await call('PUT', `/api/bookings/${id}/accept`, { actor: vendor });
    expect(res.statusCode).toBe(200);
    expect(json(res).data.status).toBe('accepted');
    expect(json(res).data.customer.email).toBe(customer.email);

    const conv = await call('GET', `/api/conversations/by-booking/${id}`, { actor: customer });
    expect(conv.statusCode).toBe(200);
    expect(json(conv).data.writable).toBe(true);
  });

  it('vendor declines with a recorded reason', async () => {
    const customer = await makeCustomer();
    const id = json(await requestBooking(customer, listingId, 14, 14)).data.id as string;
    const res = await call('PUT', `/api/bookings/${id}/decline`, { actor: vendor, body: { reason: 'Fully booked for a private event' } });
    expect(res.statusCode).toBe(200);
    expect(json(res).data).toMatchObject({ status: 'declined', declineReason: 'Fully booked for a private event' });
    const events = json(await call('GET', `/api/bookings/${id}/events`, { actor: customer })).data;
    expect(events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['requested', 'declined']);
  });

  it('a request past its 24h deadline cannot be accepted and is expired (service-level enforcement)', async () => {
    const customer = await makeCustomer();
    const id = json(await requestBooking(customer, listingId, 16, 16)).data.id as string;
    await db.update(bookings).set({ respondBy: new Date(Date.now() - 1000) }).where(eq(bookings.id, id));

    const res = await call('PUT', `/api/bookings/${id}/accept`, { actor: vendor });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('REQUEST_EXPIRED');
    const row = await db.query.bookings.findFirst({ where: eq(bookings.id, id) });
    expect(row!.status).toBe('expired');
  });

  it('expiry job and sweeper are idempotent', async () => {
    const customer = await makeCustomer();
    const id = json(await requestBooking(customer, listingId, 17, 17)).data.id as string;
    expect(await bookingsService.expire(id)).toBe(false);               // not yet due
    await db.update(bookings).set({ respondBy: new Date(Date.now() - 1000) }).where(eq(bookings.id, id));
    expect(await bookingsService.expireOverdue()).toBeGreaterThanOrEqual(1);
    expect(await bookingsService.expire(id)).toBe(false);               // duplicate delivery: no-op
    const events = await db.execute(sql`SELECT count(*)::int AS n FROM booking_events WHERE booking_id = ${id} AND to_status = 'expired'`) as unknown as { n: number }[];
    expect(events[0]!.n).toBe(1);
  });

  it('requests do not block dates; accepting one declines overlapping requests', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    const r1 = json(await requestBooking(a, listingId, 20, 22)).data.id as string;
    const r2 = json(await requestBooking(b, listingId, 21, 23)).data.id as string;
    expect((await call('PUT', `/api/bookings/${r1}/accept`, { actor: vendor })).statusCode).toBe(200);
    const other = await db.query.bookings.findFirst({ where: eq(bookings.id, r2) });
    expect(other!.status).toBe('declined');
    expect(other!.declineReason).toBe('Dates no longer available');
    // New requests over accepted dates are refused.
    const r3 = await requestBooking(await makeCustomer(), listingId, 22, 22);
    expect(r3.statusCode).toBe(409);
    expect(json(r3).code).toBe('DATES_UNAVAILABLE');
  });

  it('concurrent acceptance of overlapping requests yields exactly one accepted booking', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(json(await requestBooking(await makeCustomer(), listingId, 60, 62)).data.id as string);
    const results = await Promise.all(ids.map((id) => call('PUT', `/api/bookings/${id}/accept`, { actor: vendor })));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const rows = await db.select({ status: bookings.status }).from(bookings).where(inArray(bookings.id, ids));
    expect(rows.filter((r) => r.status === 'accepted')).toHaveLength(1);
  });

  it('the database itself rejects overlapping accepted bookings (exclusion constraint)', async () => {
    const accepted = await db.query.bookings.findFirst({ where: sql`${bookings.listingId} = ${listingId} AND ${bookings.status} = 'accepted'` });
    const insert = db.insert(bookings).values({
      listingId, customerId: accepted!.customerId, startDate: accepted!.startDate, endDate: accepted!.endDate, guests: 1,
      pricingType: 'per_day', currency: 'KES', status: 'accepted',
    });
    await expect(insert).rejects.toMatchObject({ cause: { code: '23P01' } });
  });

  it('vendors cannot block dates that already have accepted bookings; requests over blocked dates fail', async () => {
    const acc = await db.query.bookings.findFirst({ where: sql`${bookings.listingId} = ${listingId} AND ${bookings.status} = 'accepted'` });
    const day = acc!.startDate.toISOString().slice(0, 10);
    const blockBooked = await call('POST', `/api/listings/${listingId}/block`, { actor: vendor, body: { dates: [day] } });
    expect(blockBooked.statusCode).toBe(409);
    expect(json(blockBooked).code).toBe('DATES_BOOKED');

    const free = dayFromToday(90);
    expect((await call('POST', `/api/listings/${listingId}/block`, { actor: vendor, body: { dates: [free], reason: 'maintenance' } })).statusCode).toBe(200);
    const req = await call('POST', '/api/bookings', { actor: await makeCustomer(), body: { listingId, startDate: free, endDate: free, guests: 1 } });
    expect(req.statusCode).toBe(409);
    const cal = json(await call('GET', `/api/listings/${listingId}/calendar?startDate=${free}&endDate=${free}`)).data;
    expect(cal[free]).toEqual({ available: false, reason: 'Unavailable' }); // private reason not exposed
  });

  it('rejects past dates, reversed ranges and impossible dates', async () => {
    const c = await makeCustomer();
    expect((await requestBooking(c, listingId, -2, -1)).statusCode).toBe(422);
    expect((await requestBooking(c, listingId, 5, 3)).statusCode).toBe(422);
    expect((await call('POST', '/api/bookings', { actor: c, body: { listingId, startDate: '2030-02-30', endDate: '2030-03-01', guests: 1 } })).statusCode).toBe(422);
  });

  it('limits open requests per customer', async () => {
    const c = await makeCustomer();
    const extra = await makeVendor('Many Listings Co');
    const lids = [];
    for (let i = 0; i < 6; i++) lids.push(await makeListing(extra));
    const codes = [];
    for (const l of lids) codes.push((await requestBooking(c, l, 100, 100)).statusCode);
    expect(codes.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(codes[5]).toBe(409);
  });

  it('cancellation rules: customer may cancel a request; vendor may cancel only accepted bookings', async () => {
    const c = await makeCustomer();
    const id = json(await requestBooking(c, listingId, 120, 120)).data.id as string;
    expect((await call('PUT', `/api/bookings/${id}/cancel`, { actor: vendor, body: { reason: 'Vendor wants to cancel' } })).statusCode).toBe(409);
    const res = await call('PUT', `/api/bookings/${id}/cancel`, { actor: c, body: { reason: 'Plans changed, sorry' } });
    expect(json(res).data).toMatchObject({ status: 'cancelled', cancelledBy: 'customer' });
  });

  it('auto-completes accepted bookings after the end date', async () => {
    const c = await makeCustomer();
    const id = json(await requestBooking(c, listingId, 130, 130)).data.id as string;
    await call('PUT', `/api/bookings/${id}/accept`, { actor: vendor });
    await db.update(bookings).set({ startDate: new Date('2020-01-01T00:00:00Z'), endDate: new Date('2020-01-01T00:00:00Z') }).where(eq(bookings.id, id));
    expect(await bookingsService.autoComplete()).toBeGreaterThanOrEqual(1);
    expect((await db.query.bookings.findFirst({ where: eq(bookings.id, id) }))!.status).toBe('completed');
  });
});

describe('cross-vendor and cross-customer isolation', () => {
  it('another vendor cannot see, accept, decline, edit or block on a vendor\'s resources', async () => {
    const owner = await makeVendor('Owner Co');
    const intruder = await makeVendor('Intruder Co');
    const listingId = await makeListing(owner);
    const c = await makeCustomer();
    const id = json(await requestBooking(c, listingId, 15, 15)).data.id as string;

    expect((await call('GET', `/api/bookings/${id}`, { actor: intruder })).statusCode).toBe(404);
    expect((await call('PUT', `/api/bookings/${id}/accept`, { actor: intruder })).statusCode).toBe(404);
    expect((await call('PUT', `/api/bookings/${id}/decline`, { actor: intruder, body: { reason: 'not my booking at all' } })).statusCode).toBe(404);
    expect((await call('PUT', `/api/listings/${listingId}`, { actor: intruder, body: { title: 'Hijacked title here' } })).statusCode).toBe(404);
    expect((await call('PATCH', `/api/listings/${listingId}/status`, { actor: intruder, body: { status: 'paused' } })).statusCode).toBe(404);
    expect((await call('POST', `/api/listings/${listingId}/block`, { actor: intruder, body: { dates: [dayFromToday(50)] } })).statusCode).toBe(404);
    expect(json(await call('GET', '/api/bookings/vendor', { actor: intruder })).data).toHaveLength(0);
  });

  it('another customer cannot see or cancel someone else\'s booking', async () => {
    const owner = await makeVendor('Iso Co');
    const listingId = await makeListing(owner);
    const a = await makeCustomer();
    const b = await makeCustomer();
    const id = json(await requestBooking(a, listingId, 15, 15)).data.id as string;
    expect((await call('GET', `/api/bookings/${id}`, { actor: b })).statusCode).toBe(404);
    expect((await call('PUT', `/api/bookings/${id}/cancel`, { actor: b, body: { reason: 'malicious cancel attempt' } })).statusCode).toBe(404);
  });

  it('public vendor profile and booking details never expose payout details', async () => {
    const v = await makeVendor('Hidden Details Co');
    await call('POST', '/api/vendors/me/payout-details', { actor: v, body: { payoutMethod: 'bank', bankAccountName: 'Account Holder', bankAccountNumber: '0011223344', bankName: 'Test Bank' } });
    const pub = await call('GET', `/api/vendors/${v.vendorId}`);
    expect(pub.statusCode).toBe(200);
    expect(pub.body).not.toContain('0011223344');
    expect(Object.keys(json(pub).data).sort()).toEqual(['businessName', 'createdAt', 'id', 'logo', 'phoneNumber', 'slug', 'verified']);

    const lid = await makeListing(v);
    const c = await makeCustomer();
    const id = json(await requestBooking(c, lid, 15, 15)).data.id as string;
    await call('PUT', `/api/bookings/${id}/accept`, { actor: v });
    expect((await call('GET', `/api/bookings/${id}`, { actor: c })).body).not.toContain('0011223344');
  });
});

describe('suspended vendors', () => {
  it('cannot accept requests or publish, and their listings disappear from search', async () => {
    const v = await makeVendor('Suspend Me Co');
    const lid = await makeListing(v);
    const c = await makeCustomer();
    const id = json(await requestBooking(c, lid, 15, 15)).data.id as string;
    const admin = await makeAdmin();
    expect((await call('PUT', `/api/admin/vendors/${v.vendorId}/suspend`, { actor: admin, body: { reason: 'Policy violation' } })).statusCode).toBe(200);

    const acc = await call('PUT', `/api/bookings/${id}/accept`, { actor: v });
    expect(acc.statusCode).toBe(403);
    expect(json(acc).code).toBe('VENDOR_SUSPENDED');
    expect((await call('PATCH', `/api/listings/${lid}/status`, { actor: v, body: { status: 'active' } })).statusCode).toBe(403);
    expect((await call('GET', `/api/listings/${lid}`)).statusCode).toBe(404);
    const search = json(await call('GET', `/api/listings?vendorId=${v.vendorId}`)).data;
    expect(search).toHaveLength(0);
    expect((await requestBooking(await makeCustomer(), lid, 18, 18)).statusCode).toBe(404);

    // Suspension does not turn the vendor into a customer who can book.
    const other = await makeVendor('Other Co');
    const otherListing = await makeListing(other);
    expect((await requestBooking(v, otherListing, 19, 19)).statusCode).toBe(403);
    // Declining stays possible so open requests can be closed.
    expect((await call('PUT', `/api/bookings/${id}/decline`, { actor: v, body: { reason: 'Account suspended, sorry' } })).statusCode).toBe(200);
  });
});
