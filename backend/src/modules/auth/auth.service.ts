import { eq } from 'drizzle-orm';
import { db } from '../../config/database.js';
import { users } from '../../db/schema/index.js';
import { redis } from '../../config/redis.js';
import { OTP_TTL, OTP_RESEND_WAIT, sendCustomerOTP } from '../../utils/otp.js';

export class AuthService {
  async verifyCustomerOTP(userId: string, otp: string) {
    const key = `auth:otp:${userId}`;
    const stored = await redis.get(key) as string | null;
    if (!stored) throw new Error('OTP expired or not found. Please request a new one.');

    const data = JSON.parse(stored) as { otp: string; attempts: number };

    if (data.attempts >= 5) {
      await redis.del(key);
      throw new Error('Too many attempts. Please request a new code.');
    }

    if (data.otp !== otp) {
      data.attempts += 1;
      await redis.setex(key, OTP_TTL, JSON.stringify(data));
      const remaining = 5 - data.attempts;
      throw new Error(`Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`);
    }

    await redis.del(key);

    const [user] = await db.update(users)
      .set({ verified: true, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({
        id: users.id, email: users.email, fullName: users.fullName,
        phone: users.phone, role: users.role, verified: users.verified,
      });

    if (!user) throw new Error('User not found.');
    return { user };
  }

  async resendCustomerOTP(userId: string) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true, fullName: true, verified: true },
    });
    if (!user) throw new Error('User not found.');
    if (user.verified) throw new Error('Email is already verified.');

    const key = `auth:otp:${userId}`;
    const stored = await redis.get(key) as string | null;
    if (stored) {
      const ttl = await redis.ttl(key);
      if (ttl > OTP_TTL - OTP_RESEND_WAIT) {
        throw new Error('Please wait 60 seconds before requesting a new code.');
      }
    }

    await sendCustomerOTP(userId, user.email, user.fullName ?? 'there');
    return { sent: true };
  }
}