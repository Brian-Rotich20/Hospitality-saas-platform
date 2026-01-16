import { FastifyInstance } from 'fastify';
import { PayoutController } from './payouts.controller';

const payoutController = new PayoutController();

export async function payoutRoutes(fastify: FastifyInstance) {
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: {
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
  fastify.get('/', {
    preHandler: [fastify.authenticate, fastify.requireAdmin],
    schema: {
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