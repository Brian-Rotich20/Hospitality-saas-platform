// Provider webhooks/callbacks for subscription payments (mounted at /api/payments).
// These are the only unauthenticated write endpoints; each authenticates the caller in
// its own way and never trusts the payload for crediting (see service.ts).
import type { FastifyPluginAsync } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { guards, requireUser } from '../../app/policies.js';
import { idParams, ok, pagination } from '../../app/http.js';
import { paymentsService } from './service.js';

const providerParam = z.enum(['paystack', 'mpesa']).transform((p) => (p === 'mpesa' ? 'daraja' as const : p));

/**
 * Admin payment investigation (mounted at /api/admin/payments). Read-only views plus two
 * safe actions: close a review with a note, and ask the provider again. Nothing here moves
 * money, issues refunds, or changes a vendor's access.
 */
export const paymentAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const guard of guards.admin) app.addHook('preValidation', guard);

  app.get('/', {
    schema: {
      tags: ['Admin - Payments'],
      querystring: pagination.extend({
        status: z.enum(['initiated', 'pending', 'succeeded', 'failed', 'reversed', 'cancelled']).optional(),
        provider: providerParam.optional(),
        vendorId: z.string().uuid().optional(),
        needsReview: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
      }),
    },
  }, async (request) => ok(await paymentsService.listForAdmin(request.query)));

  app.get('/provider-events', {
    schema: { tags: ['Admin - Payments'], querystring: pagination.extend({ state: z.enum(['unmatched', 'unprocessed']).optional(), provider: providerParam.optional() }) },
  }, async (request) => ok(await paymentsService.listProviderEvents(request.query)));

  app.get('/:id', { schema: { tags: ['Admin - Payments'], params: idParams } },
    async (request) => ok(await paymentsService.getForAdmin(request.params.id)));

  app.post('/:id/review', { schema: { tags: ['Admin - Payments'], params: idParams, body: z.object({ note: z.string().trim().min(5).max(2000) }) } },
    async (request) => ok(await paymentsService.markReviewed(request.params.id, requireUser(request).userId, request.body.note, request.id), { message: 'Review closed' }));

  app.post('/:id/reverify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags: ['Admin - Payments'], params: idParams } },
    async (request) => ok(await paymentsService.reverifyForAdmin(request.params.id, requireUser(request).userId, request.id)));
};

export const paymentWebhookRoutes: FastifyPluginAsync = async (app) => {
  // Keep the exact bytes: Paystack's signature is computed over the raw body.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/paystack/webhook', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    schema: { tags: ['Payment provider webhooks'], summary: 'Paystack events (HMAC-SHA512 signed). Server-to-server only; not for the frontend.' },
  }, async (request, reply) => {
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const signature = request.headers['x-paystack-signature'];
    const result = await paymentsService.handlePaystackWebhook(raw, typeof signature === 'string' ? signature : undefined);
    // 401 for bad signatures; 200 otherwise (including duplicates) so Paystack stops retrying.
    if (!result.accepted) return reply.code(401).send({ success: false, error: 'invalid signature', code: 'INVALID_SIGNATURE' });
    return reply.code(200).send({ success: true, duplicate: result.duplicate ?? false });
  });

  app.post('/daraja/callback/:token', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    schema: { tags: ['Payment provider webhooks'], summary: 'M-Pesa STK Push result callback (secret path token). Server-to-server only.' },
  }, async (request, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(200) }).parse(request.params);
    let body: unknown;
    try {
      body = JSON.parse((Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0)).toString('utf8'));
    } catch {
      return reply.code(400).send({ ResultCode: 1, ResultDesc: 'Malformed body' });
    }
    const result = await paymentsService.handleDarajaCallback(token, request.ip, body);
    // Unknown token: indistinguishable from a missing route.
    if (!result.accepted) return reply.code(404).send({ success: false, error: 'Route not found', code: 'ROUTE_NOT_FOUND' });
    // Safaricom expects this acknowledgement shape.
    return reply.code(200).send({ ResultCode: 0, ResultDesc: 'Accepted' });
  });
};
