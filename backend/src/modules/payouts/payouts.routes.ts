import { FastifyInstance } from 'fastify';
import { PayoutController } from './payouts.controller';
import { getPayoutsSchema } from './payouts.schema';

const payoutController = new PayoutController();

export async function payoutRoutes(fastify: FastifyInstance) {
  // Vendor routes
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: getPayoutsSchema,
      tags: ['Payouts'],
      description: 'Get my payouts',
    },
  }, payoutController.getMyPayouts.bind(payoutController));

  fastify.get('/me/earnings', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Payouts'],
      description: 'Get earnings summary',
    },
  }, payoutController.getMyEarnings.bind(payoutController));
}

export async function payoutAdminRoutes(fastify: FastifyInstance) {
  // Admin routes
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      querystring: getPayoutsSchema,
      tags: ['Admin - Payouts'],
      description: 'Get all payouts',
    },
  }, payoutController.getAllPayouts.bind(payoutController));

  fastify.post('/:id/trigger', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Payouts'],
      description: 'Manually trigger payout',
    },
  }, payoutController.triggerManualPayout.bind(payoutController));

  fastify.post('/process-scheduled', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
      tags: ['Admin - Payouts'],
      description: 'Process all scheduled payouts (cron)',
    },
  }, payoutController.processScheduledPayouts.bind(payoutController));
}