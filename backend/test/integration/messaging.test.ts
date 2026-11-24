import { beforeAll, describe, expect, it } from 'vitest';
import { call, json, makeAdmin, makeCustomer, makeListing, makeVendor, requestBooking, type Actor } from '../helpers/app.js';

describe('customer–vendor messaging', () => {
  let vendor: Actor & { vendorId: string };
  let customer: Actor;
  let bookingId: string;
  let conversationId: string;

  beforeAll(async () => {
    vendor = await makeVendor('Chatty Venue');
    const listingId = await makeListing(vendor);
    customer = await makeCustomer();
    bookingId = json(await requestBooking(customer, listingId, 25, 26)).data.id as string;
  });

  it('there is no conversation before the vendor accepts', async () => {
    expect((await call('GET', `/api/conversations/by-booking/${bookingId}`, { actor: customer })).statusCode).toBe(404);
  });

  it('both parties can message after acceptance; others cannot see the conversation', async () => {
    await call('PUT', `/api/bookings/${bookingId}/accept`, { actor: vendor });
    conversationId = json(await call('GET', `/api/conversations/by-booking/${bookingId}`, { actor: customer })).data.id as string;

    expect((await call('POST', `/api/conversations/${conversationId}/messages`, { actor: customer, body: { body: 'Hi! Can we set up at 8am?' } })).statusCode).toBe(201);
    expect((await call('POST', `/api/conversations/${conversationId}/messages`, { actor: vendor, body: { body: 'Yes, 8am works.' } })).statusCode).toBe(201);
    const thread = json(await call('GET', `/api/conversations/${conversationId}/messages`, { actor: vendor })).data;
    expect(thread.messages.map((m: { senderRole: string }) => m.senderRole)).toEqual(['customer', 'vendor']);

    const stranger = await makeCustomer();
    const otherVendor = await makeVendor('Nosy Vendor');
    expect((await call('GET', `/api/conversations/${conversationId}/messages`, { actor: stranger })).statusCode).toBe(404);
    expect((await call('GET', `/api/conversations/${conversationId}/messages`, { actor: otherVendor })).statusCode).toBe(404);
    expect((await call('POST', `/api/conversations/${conversationId}/messages`, { actor: otherVendor, body: { body: 'spam' } })).statusCode).toBe(404);
    expect(json(await call('GET', '/api/conversations', { actor: stranger })).data).toHaveLength(0);
  });

  it('rejects empty and oversized messages', async () => {
    expect((await call('POST', `/api/conversations/${conversationId}/messages`, { actor: customer, body: { body: '   ' } })).statusCode).toBe(422);
    expect((await call('POST', `/api/conversations/${conversationId}/messages`, { actor: customer, body: { body: 'x'.repeat(2001) } })).statusCode).toBe(422);
  });

  it('a party can report a message and an admin can hide it', async () => {
    const thread = json(await call('GET', `/api/conversations/${conversationId}/messages`, { actor: customer })).data;
    const vendorMsg = thread.messages.find((m: { senderRole: string }) => m.senderRole === 'vendor');
    expect((await call('POST', `/api/messages/${vendorMsg.id}/report`, { actor: customer, body: { reason: 'Inappropriate content' } })).statusCode).toBe(201);
    const admin = await makeAdmin();
    const reports = json(await call('GET', '/api/admin/messages/reports', { actor: admin })).data;
    expect(reports.some((r: { message: { id: string } }) => r.message.id === vendorMsg.id)).toBe(true);
    expect((await call('POST', `/api/admin/messages/${vendorMsg.id}/moderate`, { actor: admin, body: { action: 'hide' } })).statusCode).toBe(200);
    const after = json(await call('GET', `/api/conversations/${conversationId}/messages`, { actor: customer })).data;
    expect(after.messages.find((m: { id: string }) => m.id === vendorMsg.id)).toMatchObject({ hidden: true, body: null });
    // Admins moderate but never post in customer conversations.
    expect((await call('POST', `/api/conversations/${conversationId}/messages`, { actor: admin, body: { body: 'hello' } })).statusCode).toBe(403);
  });

  it('the conversation becomes read-only once the booking is cancelled', async () => {
    await call('PUT', `/api/bookings/${bookingId}/cancel`, { actor: customer, body: { reason: 'Event postponed indefinitely' } });
    const res = await call('POST', `/api/conversations/${conversationId}/messages`, { actor: customer, body: { body: 'still there?' } });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('CONVERSATION_CLOSED');
    expect(json(await call('GET', `/api/conversations/${conversationId}/messages`, { actor: customer })).data.writable).toBe(false);
  });
});
