import { FastifyInstance } from 'fastify';
import { BookingController } from './bookings.controller';

const bookingController = new BookingController();

export async function bookingRoutes(fastify: FastifyInstance) {
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Create new booking request',
    },
  }, bookingController.createBooking.bind(bookingController));

  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Get my bookings',
    },
  }, bookingController.getMyBookings.bind(bookingController));

  fastify.get('/vendor', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Get vendor bookings',
    },
  }, bookingController.getVendorBookings.bind(bookingController));

  fastify.get('/vendor/pending', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Get pending bookings requiring action',
    },
  }, bookingController.getPendingBookings.bind(bookingController));

  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Get booking details',
    },
  }, bookingController.getBookingById.bind(bookingController));

  fastify.put('/:id/accept', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Accept booking request',
    },
  }, bookingController.acceptBooking.bind(bookingController));

  fastify.put('/:id/decline', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Decline booking request',
    },
  }, bookingController.declineBooking.bind(bookingController));

  fastify.put('/:id/cancel', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Cancel booking',
    },
  }, bookingController.cancelBooking.bind(bookingController));
}