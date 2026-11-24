import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { guards, requireUser, requireVendorCtx } from '../../app/policies.js';
import { calendarDate, idParams, ok, pagination } from '../../app/http.js';
import { bookingsService, LEGACY_STATUS_ALIASES, type BookingStatus } from './service.js';
import { vendorsRepo } from '../vendors/repo.js';

const STATUSES = ['requested', 'accepted', 'declined', 'expired', 'cancelled', 'completed'] as const;

// Accept the legacy names the existing frontend sends (pending, confirmed).
const statusQuery = z.string().optional().transform((s, ctx): BookingStatus | undefined => {
  if (s === undefined) return undefined;
  const mapped = LEGACY_STATUS_ALIASES[s] ?? s;
  if (!(STATUSES as readonly string[]).includes(mapped)) {
    ctx.addIssue({ code: 'custom', message: `status must be one of ${STATUSES.join(', ')}` });
    return z.NEVER;
  }
  return mapped as BookingStatus;
});
const listQuery = pagination.extend({ status: statusQuery });
const reason = z.object({ reason: z.string().trim().min(10, 'Please provide at least 10 characters').max(500) });

const requestBody = z.object({
  listingId: z.string().uuid(),
  startDate: calendarDate,
  endDate: calendarDate,
  guests: z.number().int().positive().max(10_000),
  specialRequests: z.string().max(1000).optional(),
});

/** Mounted at /api/bookings. */
export const bookingRoutes: FastifyPluginAsyncZod = async (app) => {
  // Customers only (policy) — re-checked in the service.
  app.post('/', {
    preValidation: guards.customer,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['Bookings'], body: requestBody },
  }, async (request, reply) => {
    const booking = await bookingsService.request(requireUser(request), request.body);
    reply.code(201);
    return ok(await bookingsService.getForParty(booking.id, requireUser(request), null), { message: 'Booking request sent. The vendor has 24 hours to respond.' });
  });

  app.get('/me', { preValidation: guards.user, schema: { tags: ['Bookings'], querystring: listQuery } }, async (request) => {
    const data = await bookingsService.listForCustomer(requireUser(request).userId, request.query);
    return ok(data, { count: data.length });
  });

  app.get('/vendor', { preValidation: guards.vendor, schema: { tags: ['Bookings'], querystring: listQuery } }, async (request) => {
    const data = await bookingsService.listForVendor(requireVendorCtx(request).vendor.id, request.query);
    return ok(data, { count: data.length });
  });

  app.get('/vendor/pending', { preValidation: guards.vendor, schema: { tags: ['Bookings'] } }, async (request) => {
    const data = await bookingsService.pendingForVendor(requireVendorCtx(request).vendor.id);
    return ok(data, { count: data.length });
  });

  app.get('/:id', { preValidation: guards.user, schema: { tags: ['Bookings'], params: idParams } }, async (request) => {
    const authCtx = requireUser(request);
    const vendor = authCtx.role === 'vendor' ? await vendorsRepo.findByUserId(authCtx.userId) : undefined;
    return ok(await bookingsService.getForParty(request.params.id, authCtx, vendor?.id ?? null));
  });

  app.get('/:id/events', { preValidation: guards.user, schema: { tags: ['Bookings'], params: idParams } }, async (request) => {
    const authCtx = requireUser(request);
    const vendor = authCtx.role === 'vendor' ? await vendorsRepo.findByUserId(authCtx.userId) : undefined;
    await bookingsService.getForParty(request.params.id, authCtx, vendor?.id ?? null); // authorisation
    return ok(await bookingsService.events(request.params.id));
  });

  // Accepting requires an approved vendor with an entitled subscription.
  app.put('/:id/accept', { preValidation: guards.entitledVendor, schema: { tags: ['Bookings'], params: idParams } }, async (request) => {
    const { vendor } = requireVendorCtx(request);
    await bookingsService.accept(request.params.id, vendor.id, requireUser(request).userId);
    return ok(await bookingsService.getForParty(request.params.id, requireUser(request), vendor.id), { message: 'Request accepted. You can now message the customer.' });
  });

  // Declining is allowed for any vendor so open requests can always be closed.
  app.put('/:id/decline', { preValidation: guards.vendor, schema: { tags: ['Bookings'], params: idParams, body: reason } }, async (request) => {
    const { vendor } = requireVendorCtx(request);
    await bookingsService.decline(request.params.id, vendor.id, requireUser(request).userId, request.body.reason);
    return ok(await bookingsService.getForParty(request.params.id, requireUser(request), vendor.id), { message: 'Request declined' });
  });

  app.put('/:id/cancel', { preValidation: guards.user, schema: { tags: ['Bookings'], params: idParams, body: reason } }, async (request) => {
    const authCtx = requireUser(request);
    const vendor = authCtx.role === 'vendor' ? await vendorsRepo.findByUserId(authCtx.userId) : undefined;
    await bookingsService.cancel(request.params.id, authCtx, vendor?.id ?? null, request.body.reason);
    return ok(await bookingsService.getForParty(request.params.id, authCtx, vendor?.id ?? null), { message: 'Booking cancelled' });
  });
};

/** Mounted at /api/admin/bookings. */
export const bookingAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const guard of guards.admin) app.addHook('preValidation', guard);
  app.get('/', { schema: { tags: ['Admin - Bookings'], querystring: listQuery } }, async (request) => {
    const data = await bookingsService.listForAdmin(request.query);
    return ok(data, { count: data.length });
  });
  app.get('/:id', { schema: { tags: ['Admin - Bookings'], params: idParams } },
    async (request) => ok({ ...(await bookingsService.getForParty(request.params.id, requireUser(request), null)), events: await bookingsService.events(request.params.id) }));
};
