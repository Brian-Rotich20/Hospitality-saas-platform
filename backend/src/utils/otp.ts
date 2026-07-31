import { redis } from '../config/redis.js';
import { sendCustomerVerificationEmail } from './email.js';

export const OTP_TTL = 15 * 60;
export const OTP_RESEND_WAIT = 60;

export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function sendCustomerOTP(userId: string, email: string, fullName: string) {
  const otp = generateOTP();
  const key = `auth:otp:${userId}`;
  await redis.setex(key, OTP_TTL, JSON.stringify({ otp, attempts: 0 }));
  setImmediate(() => {
    sendCustomerVerificationEmail({ to: email, fullName, otp })
      .catch(err => console.error('[Customer OTP email failed]', err?.message));
  });
}