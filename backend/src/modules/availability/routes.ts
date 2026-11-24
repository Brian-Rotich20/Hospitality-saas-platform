import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { guards, requireVendorCtx } from '../../app/policies.js';
import { calendarDate, ok } from '../../app/http.js';
import { availabilityService } from './service.js';

const listingParams = z.object({ listingId: z.string().uuid() });
const range = z.object({ startDate: calendarDate, endDate: calendarDate });
const datesBody = z.object({ dates: z.array(calendarDate).min(1).max(366) });

/** Mounted at /api (paths under /listings/:listingId). */
export const availabilityRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/listings/:listingId/availability', { schema: { tags: ['Availability'], params: listingParams, querystring: range } }, async (request) => {
    const { listingId } = request.params;
    const { startDate, endDate } = request.query;
    return ok({ available: await availabilityService.isAvailable(listingId, startDate, endDate), listingId, startDate, endDate });
  });

  app.get('/listings/:listingId/calendar', { schema: { tags: ['Availability'], params: listingParams, querystring: range } },
    async (request) => ok(await availabilityService.calendar(request.params.listingId, request.query.startDate, request.query.endDate)));

  app.post('/listings/:listingId/block', {
    preValidation: guards.activeVendor,
    schema: { tags: ['Availability'], params: listingParams, body: datesBody.extend({ reason: z.string().max(500).optional() }) },
  }, async (request) => {
    const dates = await availabilityService.block(request.params.listingId, requireVendorCtx(request).vendor.id, request.body.dates, request.body.reason);
    return ok(dates, { message: `${dates.length} date(s) blocked` });
  });

  app.post('/listings/:listingId/unblock', {
    preValidation: guards.activeVendor,
    schema: { tags: ['Availability'], params: listingParams, body: datesBody },
  }, async (request) => {
    const dates = await availabilityService.unblock(request.params.listingId, requireVendorCtx(request).vendor.id, request.body.dates);
    return ok(dates, { message: `${dates.length} date(s) unblocked` });
  });
};
