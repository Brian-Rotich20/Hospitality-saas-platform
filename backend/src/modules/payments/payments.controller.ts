import { FastifyReply, FastifyRequest } from 'fastify';
import { PaymentService } from './payments.service';
import { db } from '../../config/database';
import { vendors } from '../../db/schema';
import { eq } from 'drizzle-orm';

const paymentService = new PaymentService();

export class PaymentController {
  // Initiate M-Pesa payment
  async initiateMpesaPayment(request: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = (request.user as any).userId;
      const body = request.body as any;

      const result = await paymentService.initiateMpesaPayment(userId, body);

      return reply.code(200).send({
        success: true,
        message: result.message,
        data: result,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Payment webhook
  async handleWebhook(request: FastifyRequest, reply: FastifyReply) {
    try {
      const signature = request.headers['verif-hash'] as string;
      const payload = request.body;

      const result = await paymentService.handleWebhook(signature, payload);

      return reply.code(200).send({
        success: true,
        message: result.message,
      });
    } catch (error: any) {
      console.error('Webhook error:', error);
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Verify payment
  async verifyPayment(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { transactionId } = request.params as any;

      const result = await paymentService.verifyPaymentStatus(transactionId);

      return reply.code(200).send({
        success: true,
        data: result,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get payment details
  async getPaymentById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as any;
      const userId = (request.user as any).userId;

      const payment = await paymentService.getPaymentById(id, userId);

      return reply.code(200).send({
        success: true,
        data: payment,
      });
    } catch (error: any) {
      return reply.code(404).send({
        success: false,
        error: error.message,
      });
    }
  }

  // Get booking payments
  async getBookingPayments(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { bookingId } = request.params as any;

      const payments = await paymentService.getBookingPayments(bookingId);

      return reply.code(200).send({
        success: true,
        data: payments,
      });
    } catch (error: any) {
      return reply.code(400).send({
        success: false,
        error: error.message,
      });
    }
  }
}