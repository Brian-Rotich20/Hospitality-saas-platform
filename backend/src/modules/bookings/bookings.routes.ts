import { FastifyInstance } from 'fastify';
import { BookingController } from './bookings.controller';
import { 
  createBookingSchema, 
  declineBookingSchema,
  cancelBookingSchema,
  getBookingsSchema 
} from './bookings.schema';

const bookingController = new BookingController();

export async function bookingRoutes(fastify: FastifyInstance) {
  // Create booking
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: {
      body: createBookingSchema,
      tags: ['Bookings'],
      description: 'Create new booking request',
    },
  }, bookingController.createBooking.bind(bookingController));

  // Get my bookings (customer)
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: getBookingsSchema,
      tags: ['Bookings'],
      description: 'Get my bookings',
    },
  }, bookingController.getMyBookings.bind(bookingController));

  // Get vendor bookings
  fastify.get('/vendor', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: getBookingsSchema,
      tags: ['Bookings'],
      description: 'Get vendor bookings',
    },
  }, bookingController.getVendorBookings.bind(bookingController));

  // Get pending bookings (vendor)
  fastify.get('/vendor/pending', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Get pending bookings requiring action',
    },
  }, bookingController.getPendingBookings.bind(bookingController));

  // Get booking by ID
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Get booking details',
    },
  }, bookingController.getBookingById.bind(bookingController));

  // Accept booking (vendor)
  fastify.put('/:id/accept', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Bookings'],
      description: 'Accept booking request',
    },
  }, bookingController.acceptBooking.bind(bookingController));

  // Decline booking (vendor)
  fastify.put('/:id/decline', {
    preHandler: [fastify.authenticate],
    schema: {
      body: declineBookingSchema,
      tags: ['Bookings'],
      description: 'Decline booking request',
    },
  }, bookingController.declineBooking.bind(bookingController));

  // Cancel booking (customer)
  fastify.put('/:id/cancel', {
    preHandler: [fastify.authenticate],
    schema: {
      body: cancelBookingSchema,
      tags: ['Bookings'],
      description: 'Cancel booking',
    },
  }, bookingController.cancelBooking.bind(bookingController));
}