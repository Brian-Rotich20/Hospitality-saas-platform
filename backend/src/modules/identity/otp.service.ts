// Email verification OTP (Redis-backed).
// Hardened vs. the original: CSPRNG codes, constant-time comparison, per-code attempt
// limit and a per-user daily cap that survives resends, so a 6-digit code can't be
// brute-forced by cycling resend.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { redis } from '../../platform/cache/redis.js';
import { db } from '../../platform/database/client.js';
import { users } from '../../platform/database/schema/users.js';
import { mailer } from '../../platform/mailer/index.js';
import { templates } from '../../platform/mailer/templates.js';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError, AppError } from '../../app/errors.js';

export const OTP_TTL_SECONDS = 15 * 60;
export const OTP_RESEND_WAIT_SECONDS = 60;
const MAX_ATTEMPTS_PER_CODE = 5;
const MAX_FAILURES_PER_DAY = 20;

const codeKey = (userId: string) => `auth:otp:${userId}`;
const failKey = (userId: string) => `auth:otp:fails:${userId}:${new Date().toISOString().slice(0, 10)}`;

interface StoredOtp { otp: string; attempts: number }

function sameCode(a: string, b: string): boolean {
  const x = Buffer.from(a.padEnd(6, ' '));
  const y = Buffer.from(b.padEnd(6, ' '));
  return x.length === y.length && timingSafeEqual(x, y);
}

async function redisOp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new ServiceUnavailableError('Verification is temporarily unavailable. Please try again shortly.');
  }
}

export const otpService = {
  async issue(userId: string, email: string, name: string): Promise<void> {
    const otp = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await redisOp(() => redis.setex(codeKey(userId), OTP_TTL_SECONDS, JSON.stringify({ otp, attempts: 0 } satisfies StoredOtp)));
    const t = templates.emailOtp(name, otp);
    await mailer.send({ to: email, subject: t.subject, html: t.html, tag: 'auth.otp' });
  },

  async verify(userId: string, otp: string) {
    const fails = Number(await redisOp(() => redis.get(failKey(userId))) ?? 0);
    if (fails >= MAX_FAILURES_PER_DAY) {
      throw new AppError(429, 'OTP_DAILY_LIMIT', 'Too many failed attempts today. Try again tomorrow.');
    }
    const raw = await redisOp(() => redis.get(codeKey(userId)));
    if (!raw) throw new ValidationError('Code expired or not found. Request a new one.');
    const data = JSON.parse(raw) as StoredOtp;

    if (data.attempts >= MAX_ATTEMPTS_PER_CODE) {
      await redisOp(() => redis.del(codeKey(userId)));
      throw new ValidationError('Too many attempts. Request a new code.');
    }

    if (!sameCode(data.otp, otp)) {
      data.attempts += 1;
      const ttl = await redisOp(() => redis.ttl(codeKey(userId)));
      await redisOp(() => redis.setex(codeKey(userId), Math.max(ttl, 1), JSON.stringify(data)));
      await redisOp(async () => { await redis.multi().incr(failKey(userId)).expire(failKey(userId), 86_400).exec(); });
      const remaining = MAX_ATTEMPTS_PER_CODE - data.attempts;
      throw new ValidationError(`Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
    }

    await redisOp(() => redis.del(codeKey(userId)));
    const [user] = await db.update(users)
      .set({ verified: true, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id, email: users.email, fullName: users.fullName, phone: users.phone, role: users.role, verified: users.verified });
    if (!user) throw new NotFoundError('User');
    return user;
  },

  async resend(userId: string): Promise<void> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { id: true, email: true, fullName: true, verified: true },
    });
    if (!user) throw new NotFoundError('User');
    if (user.verified) throw new ConflictError('Email is already verified.', 'ALREADY_VERIFIED');
    const ttl = await redisOp(() => redis.ttl(codeKey(userId)));
    if (ttl > OTP_TTL_SECONDS - OTP_RESEND_WAIT_SECONDS) {
      throw new AppError(429, 'OTP_RESEND_TOO_SOON', 'Please wait 60 seconds before requesting a new code.');
    }
    await this.issue(user.id, user.email, user.fullName ?? 'there');
  },
};
