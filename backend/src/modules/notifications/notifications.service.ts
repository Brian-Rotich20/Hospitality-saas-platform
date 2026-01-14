import { EmailService } from './email.service';
import { SmsService } from './sms.service';

const emailService = new EmailService();
const smsService = new SmsService();

export class NotificationService {
  // Booking confirmed
  async notifyBookingConfirmed(booking: any) {
    try {
      await emailService.sendBookingConfirmation(booking.customer.email, {
        listingTitle: booking.listing.title,
        startDate: booking.startDate,
        endDate: booking.endDate,
        guests: booking.guests,
        totalAmount: booking.totalAmount,
      });

      await smsService.sendBookingConfirmationSms(booking.customer.phone, booking.id);
    } catch (error) {
      console.error('Notification failed:', error);
    }
  }

  // Payment received
  async notifyPaymentReceived(payment: any, customer: any) {
    try {
      await emailService.sendPaymentReceipt(customer.email, {
        transactionId: payment.transactionId,
        amount: payment.amount,
      });

      await smsService.sendPaymentConfirmationSms(customer.phone, payment.amount);
    } catch (error) {
      console.error('Notification failed:', error);
    }
  }

  // Vendor approved
  async notifyVendorApproved(vendor: any, user: any) {
    try {
      await emailService.sendVendorApproval(user.email, vendor.businessName);
    } catch (error) {
      console.error('Notification failed:', error);
    }
  }

  // Payout completed
  async notifyPayoutCompleted(payout: any, vendor: any, user: any) {
    try {
      await emailService.sendPayoutNotification(user.email, {
        netAmount: payout.netAmount,
        payoutMethod: payout.payoutMethod,
        gatewayReference: payout.gatewayReference,
      });
    } catch (error) {
      console.error('Notification failed:', error);
    }
  }
}

export const notificationService = new NotificationService();