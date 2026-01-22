import { FastifyInstance } from 'fastify';
import { AvailabilityController } from './availability.controller';

const availabilityController = new AvailabilityController();

export async function availabilityRoutes(fastify: FastifyInstance) {
  // Public - check availability
  fastify.get('/listings/:listingId/availability', {
    schema: {
      tags: ['Availability'],
      description: 'Check if listing is available for date range',
    },
  }, availabilityController.checkAvailability.bind(availabilityController));

  // Public - get calendar-
  fastify.get('/listings/:listingId/calendar', {
    schema: {
      tags: ['Availability'],
      description: 'Get availability calendar for listing',
    },
  }, availabilityController.getCalendar.bind(availabilityController));

  // Vendor - block dates
  fastify.post('/listings/:listingId/block', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Availability'],
      description: 'Block dates for listing',
    },
  }, availabilityController.blockDates.bind(availabilityController));

  // Vendor - unblock dates
  fastify.post('/listings/:listingId/unblock', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Availability'],
      description: 'Unblock dates for listing',
    },
  }, availabilityController.unblockDates.bind(availabilityController));
}