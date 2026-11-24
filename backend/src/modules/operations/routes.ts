import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { guards, requireUser } from '../../app/policies.js';
import { idParams, ok, pagination } from '../../app/http.js';
import { QUEUES } from '../../platform/queue/index.js';
import { operationsService } from './service.js';

const queueParam = z.enum([QUEUES.bookings, QUEUES.scheduler]);

/** Mounted at /api/admin/operations. Admin only. */
export const operationsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  for (const guard of guards.admin) app.addHook('preValidation', guard);

  app.get('/health', { schema: { tags: ['Admin - Operations'] } }, async () => ok(await operationsService.health()));

  app.get('/queues/:queue/failed', { schema: { tags: ['Admin - Operations'], params: z.object({ queue: queueParam }), querystring: pagination } },
    async (request) => ok(await operationsService.failedJobs(request.params.queue, request.query.limit, request.query.offset)));

  app.post('/queues/:queue/jobs/:jobId/retry', {
    schema: { tags: ['Admin - Operations'], params: z.object({ queue: queueParam, jobId: z.string().min(1).max(200) }) },
  }, async (request) => ok(await operationsService.retryJob(request.params.queue, request.params.jobId, requireUser(request).userId, request.id), { message: 'Job re-queued' }));

  app.get('/outbox', {
    schema: { tags: ['Admin - Operations'], querystring: pagination.extend({ state: z.enum(['failed', 'pending', 'retrying']).default('failed'), topic: z.string().max(100).optional() }) },
  }, async (request) => ok(await operationsService.listOutbox(request.query)));

  app.post('/outbox/:id/retry', { schema: { tags: ['Admin - Operations'], params: idParams } },
    async (request) => ok(await operationsService.retryOutbox(request.params.id, requireUser(request).userId, request.id), { message: 'Notification re-queued' }));

  app.get('/audit', {
    schema: {
      tags: ['Admin - Operations'],
      querystring: pagination.extend({
        entityType: z.string().max(50).optional(), entityId: z.string().max(100).optional(), action: z.string().max(100).optional(),
        actorUserId: z.string().uuid().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
      }),
    },
  }, async (request) => ok(await operationsService.listAudit(request.query)));
};
