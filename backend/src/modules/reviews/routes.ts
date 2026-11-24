import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { guards, requireUser, requireVendorCtx } from '../../app/policies.js';
import { ok, pagination } from '../../app/http.js';
import { reviewsService } from './service.js';

const listingParam = z.object({ listingId: z.string().uuid() });
const reviewParam = z.object({ reviewId: z.string().uuid() });

/** Mounted at /api/reviews. */
export const reviewRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/', {
    preValidation: guards.customer,
    schema: { tags: ['Reviews'], body: z.object({ bookingId: z.string().uuid(), rating: z.number().int().min(1).max(5), title: z.string().max(120).optional(), body: z.string().trim().min(10).max(2000) }) },
  }, async (request, reply) => {
    reply.code(201);
    return ok(await reviewsService.create(requireUser(request).userId, request.body));
  });

  app.get('/listing/:listingId', { schema: { tags: ['Reviews'], params: listingParam, querystring: pagination } },
    async (request) => ok(await reviewsService.forListing(request.params.listingId, request.query.limit, request.query.offset)));

  app.get('/eligibility/:listingId', { preValidation: guards.verifiedUser, schema: { tags: ['Reviews'], params: listingParam } }, async (request) => {
    const authCtx = requireUser(request);
    if (authCtx.role !== 'customer') return ok({ canReview: false, bookingId: null, reason: 'Only customers can review' });
    return ok(await reviewsService.eligibility(authCtx.userId, request.params.listingId));
  });

  app.post('/:reviewId/reply', { preValidation: guards.vendor, schema: { tags: ['Reviews'], params: reviewParam, body: z.object({ reply: z.string().trim().min(5).max(1000) }) } },
    async (request) => ok(await reviewsService.reply(request.params.reviewId, requireVendorCtx(request).vendor.id, request.body.reply)));

  app.patch('/:reviewId/visibility', { preValidation: guards.admin, schema: { tags: ['Reviews'], params: reviewParam, body: z.object({ isVisible: z.boolean() }) } },
    async (request) => ok(await reviewsService.setVisibility(request.params.reviewId, request.body.isVisible, requireUser(request).userId, request.id)));
};
