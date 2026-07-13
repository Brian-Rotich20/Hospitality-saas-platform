// src/modules/reviews/reviews.routes.ts
import { FastifyInstance } from 'fastify';
import { ReviewService }   from './reviews.service';
import { createReviewSchema, vendorReplySchema } from './reviews.schema';

const reviewService = new ReviewService();

export async function reviewRoutes(fastify: FastifyInstance) {

  // POST /api/reviews — customer submits a review (must have completed booking)
  fastify.post('/', {
    preHandler: [fastify.authenticate, fastify.requireVerified],
  }, async (req, reply) => {
    const user = (req as any).user;
    if (user.role !== 'customer') return reply.code(403).send({ error: 'Customers only' });

    const parsed = createReviewSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const review = await reviewService.createReview(user.userId, parsed.data);
    return reply.code(201).send({ success: true, data: review });
  });

  // GET /api/reviews/listing/:listingId — public list of reviews
  fastify.get('/listing/:listingId', async (req, reply) => {
    const { listingId } = req.params as { listingId: string };
    const { limit = 20, offset = 0 } = req.query as { limit?: number; offset?: number };

    const [reviews, stats] = await Promise.all([
      reviewService.getListingReviews(listingId, Number(limit), Number(offset)),
      reviewService.getListingReviewStats(listingId),
    ]);

    return reply.send({ success: true, data: { reviews, stats } });
  });

  // GET /api/reviews/eligibility/:listingId — can this customer review?
  fastify.get('/eligibility/:listingId', {
    preHandler: [fastify.authenticate, fastify.requireVerified],
  }, async (req, reply) => {
    const user = (req as any).user;
    if (user.role !== 'customer') return reply.send({ success: true, data: { canReview: false } });

    const { listingId } = req.params as { listingId: string };
    const result = await reviewService.getReviewEligibility(user.userId, listingId);
    return reply.send({ success: true, data: result });
  });

  // POST /api/reviews/:reviewId/reply — vendor replies to a review
  fastify.post('/:reviewId/reply', {
    preHandler: [fastify.authenticate, fastify.requireVerified],
  }, async (req, reply) => {
    const user = (req as any).user;
    if (user.role !== 'vendor') return reply.code(403).send({ error: 'Vendors only' });

    const vendor = await (fastify as any).db.query.vendors.findFirst({
      where: (v: any, { eq }: any) => eq(v.userId, user.userId),
    });
    if (!vendor) return reply.code(404).send({ error: 'Vendor profile not found' });

    const parsed = vendorReplySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { reviewId } = req.params as { reviewId: string };
    const updated = await reviewService.addVendorReply(reviewId, vendor.id, parsed.data);
    return reply.send({ success: true, data: updated });
  });

  // PATCH /api/reviews/:reviewId/visibility — admin moderation
  fastify.patch('/:reviewId/visibility', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
  }, async (req, reply) => {
    const { reviewId } = req.params as { reviewId: string };
    const { isVisible } = req.body as { isVisible: boolean };
    const updated = await reviewService.setVisibility(reviewId, isVisible);
    return reply.send({ success: true, data: updated });
  });
}