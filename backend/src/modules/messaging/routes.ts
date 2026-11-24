import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { guards, requireUser } from '../../app/policies.js';
import { idParams, ok } from '../../app/http.js';
import { messagingService } from './service.js';

/** Mounted at /api/conversations. */
export const conversationRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const guard of guards.user) app.addHook('preValidation', guard);

  app.get('/', { schema: { tags: ['Messaging'] } }, async (request) => ok(await messagingService.listMine(requireUser(request))));

  app.get('/by-booking/:bookingId', { schema: { tags: ['Messaging'], params: z.object({ bookingId: z.string().uuid() }) } },
    async (request) => ok(await messagingService.byBooking(request.params.bookingId, requireUser(request))));

  app.get('/:id/messages', {
    schema: { tags: ['Messaging'], params: idParams, querystring: z.object({ after: z.coerce.date().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }) },
  }, async (request) => ok(await messagingService.listMessages(request.params.id, requireUser(request), request.query)));

  app.post('/:id/messages', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { tags: ['Messaging'], params: idParams, body: z.object({ body: z.string().trim().min(1).max(2000) }) },
  }, async (request, reply) => {
    reply.code(201);
    return ok(await messagingService.send(request.params.id, requireUser(request), request.body.body));
  });
};

/** Mounted at /api/messages. */
export const messageRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post('/:id/report', {
    preValidation: guards.user,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { tags: ['Messaging'], params: idParams, body: z.object({ reason: z.string().trim().min(5).max(500) }) },
  }, async (request, reply) => {
    reply.code(201);
    return ok(await messagingService.report(request.params.id, requireUser(request), request.body.reason));
  });
};

/** Mounted at /api/admin/messages. */
export const messageAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const guard of guards.admin) app.addHook('preValidation', guard);
  app.get('/reports', { schema: { tags: ['Admin - Messaging'] } }, async () => ok(await messagingService.listOpenReports()));
  app.post('/:id/moderate', { schema: { tags: ['Admin - Messaging'], params: idParams, body: z.object({ action: z.enum(['hide', 'dismiss']) }) } },
    async (request) => ok(await messagingService.moderate(request.params.id, requireUser(request).userId, request.body.action, request.id)));
};
