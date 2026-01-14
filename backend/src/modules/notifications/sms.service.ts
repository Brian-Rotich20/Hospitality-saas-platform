import axios from 'axios';
import { env } from '../../config/env';

export class SmsService {
  private readonly AT_BASE_URL = 'https://api.sandbox.africastalking.com/version1';

  async sendSms(to: string, message: string) {
    if (!env.AFRICASTALKING_API_KEY) {
      console.log('📱 SMS (Africa\'s Talking not configured):', { to, message });
      return;
    }

    try {
      const response = await axios.post(
        `${this.AT_BASE_URL}/messaging`,
        new URLSearchParams({
          username: env.AFRICASTALKING_USERNAME || 'sandbox',
          to,
          message,
        }),
        {
          headers: {
            apiKey: env.AFRICASTALKING_API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      console.log(`✅ SMS sent to ${to}`);
      return response.data;
    } catch (error: any) {
      console.error('❌ SMS send failed:', error.message);
      throw error;
    }
  }

  async sendBookingConfirmationSms(to: string, bookingId: string) {
    const message = `Your booking ${bookingId} has been confirmed. Check your email for details.`;
    await this.sendSms(to, message);
  }

  async sendPaymentConfirmationSms(to: string, amount: string) {
    const message = `Payment of KES ${amount} received successfully. Thank you!`;
    await this.sendSms(to, message);
  }
}