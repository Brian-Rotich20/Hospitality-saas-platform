import sgMail from '@sendgrid/mail';
import { env } from '../../config/env';

if (env.SENDGRID_API_KEY) {
  sgMail.setApiKey(env.SENDGRID_API_KEY);
}

export class EmailService {
  async sendEmail(to: string, subject: string, html: string) {
    if (!env.SENDGRID_API_KEY) {
      console.log('📧 Email (SendGrid not configured):', { to, subject });
      return;
    }

    try {
      await sgMail.send({
        to,
        from: {
          email: env.FROM_EMAIL || 'noreply@example.com',
          name: env.FROM_NAME || 'Hospitality SaaS',
        },
        subject,
        html,
      });

      console.log(`✅ Email sent to ${to}`);
    } catch (error: any) {
      console.error('❌ Email send failed:', error.message);
      throw error;
    }
  }

  async sendBookingConfirmation(to: string, bookingDetails: any) {
    const subject = 'Booking Confirmation';
    const html = `
      <h1>Booking Confirmed!</h1>
      <p>Your booking has been confirmed.</p>
      <h3>Details:</h3>
      <ul>
        <li>Listing: ${bookingDetails.listingTitle}</li>
        <li>Date: ${bookingDetails.startDate} to ${bookingDetails.endDate}</li>
        <li>Guests: ${bookingDetails.guests}</li>
        <li>Total: KES ${bookingDetails.totalAmount}</li>
      </ul>
      <p>Thank you for your booking!</p>
    `;

    await this.sendEmail(to, subject, html);
  }

  async sendPaymentReceipt(to: string, paymentDetails: any) {
    const subject = 'Payment Receipt';
    const html = `
      <h1>Payment Successful</h1>
      <p>Your payment has been received.</p>
      <h3>Receipt:</h3>
      <ul>
        <li>Transaction ID: ${paymentDetails.transactionId}</li>
        <li>Amount: KES ${paymentDetails.amount}</li>
        <li>Date: ${new Date().toLocaleDateString()}</li>
      </ul>
    `;

    await this.sendEmail(to, subject, html);
  }

  async sendVendorApproval(to: string, vendorName: string) {
    const subject = 'Vendor Application Approved';
    const html = `
      <h1>Congratulations!</h1>
      <p>Your vendor application has been approved.</p>
      <p>You can now start creating listings and accepting bookings.</p>
      <p><a href="${env.APP_URL}/vendor/dashboard">Go to Dashboard</a></p>
    `;

    await this.sendEmail(to, subject, html);
  }

  async sendPayoutNotification(to: string, payoutDetails: any) {
    const subject = 'Payout Processed';
    const html = `
      <h1>Payout Completed</h1>
      <p>Your payout has been processed.</p>
      <h3>Details:</h3>
      <ul>
        <li>Amount: KES ${payoutDetails.netAmount}</li>
        <li>Method: ${payoutDetails.payoutMethod}</li>
        <li>Reference: ${payoutDetails.gatewayReference}</li>
      </ul>
    `;

    await this.sendEmail(to, subject, html);
  }
}