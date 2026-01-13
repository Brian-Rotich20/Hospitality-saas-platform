import axios from 'axios';
import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../../config/database';
import { payments, bookings } from '../../db/schema';
import { env } from '../../config/env';
import type { InitiateMpesaPaymentInput } from './payments.schema';

export class PaymentService {
  private readonly FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v3';

  // Format phone number to international format
  private formatPhoneNumber(phone: string): string {
    // Remove any spaces or special characters
    phone = phone.replace(/[\s\-\(\)]/g, '');
    
    // Convert to international format
    if (phone.startsWith('0')) {
      return '254' + phone.substring(1);
    } else if (phone.startsWith('+254')) {
      return phone.substring(1);
    } else if (phone.startsWith('254')) {
      return phone;
    }
    
    return phone;
  }

  // Generate transaction reference
  private generateTxRef(): string {
    return `HOSP-${Date.now()}-${Math.random().toString(36).substring(7).toUpperCase()}`;
  }

  // Initiate M-Pesa payment
  async initiateMpesaPayment(customerId: string, data: InitiateMpesaPaymentInput) {
    // Get booking
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, data.bookingId),
      with: {
        customer: true,
        listing: {
          with: {
            vendor: true,
          },
        },
      },
    });

    if (!booking) {
      throw new Error('Booking not found');
    }

    if (booking.customerId !== customerId) {
      throw new Error('Unauthorized');
    }

    if (booking.status !== 'pending' && booking.status !== 'confirmed') {
      throw new Error('Booking cannot be paid');
    }

    // Check if payment already exists
    const existingPayment = await db.query.payments.findFirst({
      where: and(
        eq(payments.bookingId, data.bookingId),
        eq(payments.status, 'completed')
      ),
    });

    if (existingPayment) {
      throw new Error('Booking already paid');
    }

    // Format phone number
    const formattedPhone = this.formatPhoneNumber(data.phoneNumber);

    // Generate transaction reference
    const txRef = this.generateTxRef();

    // Create payment record
    const paymentResult = await db.insert(payments).values({
      bookingId: data.bookingId,
      amount: booking.totalAmount,
      currency: 'KES',
      method: 'mpesa',
      status: 'pending',
      phoneNumber: formattedPhone,
      transactionId: txRef,
    }).returning();

    // Add check for payment creation
        if (!paymentResult[0]) {
    throw new Error('Failed to create payment record');
    }

    const payment = paymentResult[0];
    try {
      // Call Flutterwave API for M-Pesa STK Push
      const response = await axios.post(
        `${this.FLUTTERWAVE_BASE_URL}/charges?type=mobile_money_kenya`,
        {
          tx_ref: txRef,
          amount: parseFloat(booking.totalAmount),
          currency: 'KES',
          email: booking.customer.email,
          phone_number: formattedPhone,
          fullname: booking.customer.email.split('@')[0],
        },
        {
          headers: {
            Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      // Update payment with gateway reference
      await db.update(payments)
        .set({
          status: 'processing',
          gatewayReference: response.data.data?.id?.toString(),
          gatewayResponse: response.data,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      return {
        paymentId: payment.id,
        transactionId: txRef,
        status: 'processing',
        message: 'Please check your phone and enter M-Pesa PIN to complete payment',
        gatewayResponse: response.data,
      };
    } catch (error: any) {
      // Update payment as failed
      await db.update(payments)
        .set({
          status: 'failed',
          failureReason: error.response?.data?.message || error.message,
          gatewayResponse: error.response?.data,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      throw new Error(`Payment initiation failed: ${error.response?.data?.message || error.message}`);
    }
  }

  // Verify payment webhook signature
  private verifyWebhookSignature(signature: string, payload: string): boolean {
    const hash = crypto
      .createHmac('sha256', env.FLUTTERWAVE_WEBHOOK_SECRET || '')
      .update(payload)
      .digest('hex');

    return hash === signature;
  }

  // Handle payment webhook
  async handleWebhook(signature: string, payload: any) {
    // Verify webhook signature
    const isValid = this.verifyWebhookSignature(signature, JSON.stringify(payload));

    if (!isValid) {
      throw new Error('Invalid webhook signature');
    }

    const { event, data } = payload;

    if (event !== 'charge.completed') {
      return { message: 'Event ignored' };
    }

    // Find payment by transaction reference
    const payment = await db.query.payments.findFirst({
      where: eq(payments.transactionId, data.tx_ref),
      with: {
        booking: true,
      },
    });

    if (!payment) {
      throw new Error('Payment not found');
    }

    // Check if payment is successful
    if (data.status === 'successful' && data.amount >= parseFloat(payment.amount)) {
      // Update payment status
      await db.update(payments)
        .set({
          status: 'completed',
          gatewayReference: data.flw_ref,
          gatewayResponse: data,
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      // Update booking status to confirmed
      await db.update(bookings)
        .set({
          status: 'confirmed',
          updatedAt: new Date(),
        })
        .where(eq(bookings.id, payment.bookingId));

      // TODO: Send confirmation email/SMS to customer
      // TODO: Notify vendor of new booking

      return { message: 'Payment completed successfully', paymentId: payment.id };
    } else {
      // Payment failed
      await db.update(payments)
        .set({
          status: 'failed',
          failureReason: data.status,
          gatewayResponse: data,
          updatedAt: new Date(),
        })
        .where(eq(payments.id, payment.id));

      return { message: 'Payment failed', paymentId: payment.id };
    }
  }

  // Verify payment status (for manual check)
  async verifyPaymentStatus(transactionId: string) {
    try {
      const response = await axios.get(
        `${this.FLUTTERWAVE_BASE_URL}/transactions/verify_by_reference?tx_ref=${transactionId}`,
        {
          headers: {
            Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
          },
        }
      );

      const { data } = response.data;

      // Find payment
      const payment = await db.query.payments.findFirst({
        where: eq(payments.transactionId, transactionId),
      });

      if (!payment) {
        throw new Error('Payment not found');
      }

      // Update payment based on verification
      if (data.status === 'successful') {
        await db.update(payments)
          .set({
            status: 'completed',
            gatewayResponse: data,
            paidAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(payments.id, payment.id));

        // Update booking
        await db.update(bookings)
          .set({
            status: 'confirmed',
            updatedAt: new Date(),
          })
          .where(eq(bookings.id, payment.bookingId));
      }

      return {
        transactionId,
        status: data.status,
        amount: data.amount,
        currency: data.currency,
      };
    } catch (error: any) {
      throw new Error(`Verification failed: ${error.response?.data?.message || error.message}`);
    }
  }

  // Get payment by ID
  async getPaymentById(paymentId: string, userId: string) {
    const payment = await db.query.payments.findFirst({
      where: eq(payments.id, paymentId),
      with: {
        booking: {
          with: {
            customer: true,
            listing: true,
          },
        },
      },
    });

    if (!payment) {
      throw new Error('Payment not found');
    }

    // Authorization check
    if (payment.booking.customerId !== userId) {
      throw new Error('Unauthorized');
    }

    return payment;
  }

  // Get booking payments
  async getBookingPayments(bookingId: string) {
    const bookingPayments = await db.query.payments.findMany({
      where: eq(payments.bookingId, bookingId),
      orderBy: (payments, { desc }) => [desc(payments.createdAt)],
    });

    return bookingPayments;
  }
}