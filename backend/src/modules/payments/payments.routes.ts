import { FastifyInstance } from 'fastify';
import { PaymentController } from './payments.controller';
import { initiateMpesaPaymentSchema } from './payments.schema';

const paymentController = new PaymentController();

export async function paymentRoutes(fastify: FastifyInstance) {
  // Initiate M-Pesa payment
  fastify.post('/mpesa', {
    preHandler: [fastify.authenticate],
    schema: {
      body: initiateMpesaPaymentSchema,
      tags: ['Payments'],
      description: 'Initiate M-Pesa payment',
    },
  }, paymentController.initiateMpesaPayment.bind(paymentController));

  // Payment webhook (no auth)
  fastify.post('/webhook', {
    schema: {
      tags: ['Payments'],
      description: 'Flutterwave payment webhook',
    },
  }, paymentController.handleWebhook.bind(paymentController));

  // Verify payment
  fastify.get('/verify/:transactionId', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Payments'],
      description: 'Verify payment status',
    },
  }, paymentController.verifyPayment.bind(paymentController));

  // Get payment details
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Payments'],
      description: 'Get payment details',
    },
  }, paymentController.getPaymentById.bind(paymentController));

  // Get booking payments
  fastify.get('/booking/:bookingId', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Payments'],
      description: 'Get all payments for a booking',
    },
  }, paymentController.getBookingPayments.bind(paymentController));
}