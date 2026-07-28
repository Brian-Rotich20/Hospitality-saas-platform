// src/modules/auth/auth.service.ts
import { eq } from 'drizzle-orm';
import { db }  from '../../config/database.js';
import { users, vendors }      from '../../db/schema.js';
import { hashPassword, comparePassword } from '../../utils/password.js';
import { redis }               from '../../config/redis.js';
import { sendCustomerVerificationEmail } from '../../utils/email.js';
import type { RegisterInput, LoginInput } from './auth.schema.js';
import { signAccessToken, signRefreshToken, verifyToken } from '../../utils/jwt.js';

const REFRESH_TTL_SECS = 60 * 60 * 24 * 7;
const OTP_TTL          = 15 * 60;
const OTP_RESEND_WAIT  = 60;

function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function safeUser(user: any) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// ── Build JWT pair ─────────────────────────────────────────────────────────────
async function buildTokens(user: {
  id:            string;
  email:         string;
  role:          'customer' | 'vendor' | 'admin';
  emailVerified: boolean;
}) {
  let vendorId: string | undefined;
  if (user.role === 'vendor') {
    const row = await db.query.vendors.findFirst({
      where:   eq(vendors.userId, user.id),
      columns: { id: true },
    });
    vendorId = row?.id;
  }

  const payload = {
    userId:        user.id,
    email:         user.email,
    role:          user.role,
    emailVerified: user.emailVerified,
    vendorId,
  };

  const accessToken  = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  await redis.setex(
    `refresh:${user.id}:${refreshToken.slice(-20)}`,
    REFRESH_TTL_SECS,
    refreshToken,
  );

  return { accessToken, refreshToken };
}

// ── Send customer OTP (internal) ───────────────────────────────────────────────
async function sendCustomerOTP(userId: string, email: string, fullName: string) {
  const otp = generateOTP();
  const key = `auth:otp:${userId}`;
  // Store FIRST (sync) — then fire email non-blocking
  await redis.setex(key, OTP_TTL, JSON.stringify({ otp, attempts: 0 }));
  setImmediate(() => {
    sendCustomerVerificationEmail({ to: email, fullName, otp })
      .catch(err => console.error('[Customer OTP email failed]', err?.message));
  });
}

export class AuthService {

  // ── Register ──────────────────────────────────────────────────────────────────
  async register(data: RegisterInput) {
    const existing = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });

    if (existing) {
      // Google account — allow password linking
      if (!existing.passwordHash && existing.googleId) {
        const passwordHash = await hashPassword(data.password);
        const [updated] = await db.update(users)
          .set({ passwordHash, fullName: data.fullName ?? existing.fullName, phone: data.phone ?? existing.phone, updatedAt: new Date() })
          .where(eq(users.id, existing.id))
          .returning({ id: users.id, email: users.email, fullName: users.fullName, phone: users.phone, role: users.role, verified: users.verified });
        if (!updated) throw new Error('Failed to link account. Please try again.');
        const { accessToken, refreshToken } = await buildTokens({
          id: updated.id, email: updated.email, role: updated.role as any,
          emailVerified: updated.verified ?? true,
        });
        return { user: updated, accessToken, refreshToken, requiresVerification: false };
      }
      throw new Error('An account with this email already exists. Please sign in.');
    }

    try {
      const passwordHash = await hashPassword(data.password);
      const role = 'customer';

      const [user] = await db.insert(users).values({
        fullName: data.fullName, email: data.email, phone: data.phone,
        passwordHash, role, verified: false,
      }).returning({
        id: users.id, email: users.email, fullName: users.fullName,
        phone: users.phone, role: users.role, verified: users.verified,
      });

      if (!user) throw new Error('Registration failed. Please try again.');

      // Send OTP — Redis write is awaited; email fires in background
      await sendCustomerOTP(user.id, user.email, user.fullName ?? 'there');

      // emailVerified=false — middleware will redirect to verify-email on every protected route
      const { accessToken, refreshToken } = await buildTokens({
        id: user.id, email: user.email, role: user.role as any, emailVerified: false,
      });

      return { user, accessToken, refreshToken, requiresVerification: true };

    } catch (err: any) {
      if (err.message?.includes('unique') || err.code === '23505') {
        if (err.message?.includes('phone')) throw new Error('This phone number is already registered.');
        if (err.message?.includes('email')) throw new Error('An account with this email already exists. Please sign in.');
        throw new Error('An account with these details already exists.');
      }
      throw err;
    }
  }

  // ── Verify customer OTP ────────────────────────────────────────────────────────
  async verifyCustomerOTP(userId: string, otp: string) {
    const key    = `auth:otp:${userId}`;
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

    // Fresh token — emailVerified=true unlocks all protected routes
    const { accessToken, refreshToken } = await buildTokens({
      id: user.id, email: user.email, role: user.role as any, emailVerified: true,
    });

    return { user, accessToken, refreshToken };
  }

  // ── Resend customer OTP ────────────────────────────────────────────────────────
  async resendCustomerOTP(userId: string) {
    const user = await db.query.users.findFirst({
      where:   eq(users.id, userId),
      columns: { id: true, email: true, fullName: true, verified: true },
    });
    if (!user)         throw new Error('User not found.');
    if (user.verified) throw new Error('Email is already verified.');

    const key    = `auth:otp:${userId}`;
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

  // ── Login — hard blocks unverified users ───────────────────────────────────────
  async login(data: LoginInput) {
    const user = await db.query.users.findFirst({ where: eq(users.email, data.email) });
    if (!user) throw new Error('Invalid email or password');
    if (!user.passwordHash) throw new Error('This account uses Google sign-in. Please click "Continue with Google".');

    const valid = await comparePassword(data.password, user.passwordHash);
    if (!valid) throw new Error('Invalid email or password');

    if (!user.verified && user.role !== 'admin') { //Admin can log in without verifying email
      // Re-send OTP automatically so they can verify right away
      sendCustomerOTP(user.id, user.email, user.fullName ?? 'there').catch(() => {});

      const { accessToken } = await buildTokens({
        id: user.id, email: user.email, role: user.role as any, emailVerified: false,
      });

      // Attach accessToken to the error so controller can return it to frontend
      throw Object.assign(
        new Error('Please verify your email before signing in. We just resent your code.'),
        { code: 'EMAIL_NOT_VERIFIED', accessToken },
      );
    }
    const emailVerified = user.role === 'admin' ? true : (user.verified ?? false);

    const { accessToken, refreshToken } = await buildTokens({
      id: user.id,
      email: user.email, 
      role: user.role as any, 
      emailVerified: true,
    });
    return { user: safeUser(user), accessToken, refreshToken };
  }

  // ── Google auth — Google already verified the email ────────────────────────────
  async googleAuth(profile: { googleId: string; email: string; fullName: string; avatarUrl: string | undefined }) {
    let user = await db.query.users.findFirst({ where: eq(users.googleId, profile.googleId) });

    if (!user) {
      const existing = await db.query.users.findFirst({ where: eq(users.email, profile.email) });
      if (existing) {
        const rows = await db.update(users)
          .set({ googleId: profile.googleId, verified: true, ...(!existing.avatarUrl && profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}) })
          .where(eq(users.id, existing.id)).returning();
        user = rows[0];
      }
    }

    if (!user) {
      const rows = await db.insert(users).values({
        fullName: profile.fullName, email: profile.email, googleId: profile.googleId,
        avatarUrl: profile.avatarUrl ?? null, role: 'customer', verified: true,
      }).returning();
      user = rows[0];
    }

    if (!user) throw new Error('Failed to create or retrieve user account.');

    const { accessToken, refreshToken } = await buildTokens({
      id: user.id, email: user.email, role: user.role as any, emailVerified: true,
    });
    return { user: safeUser(user), accessToken, refreshToken };
  }

  // ── Refresh ────────────────────────────────────────────────────────────────────
  async refresh(refreshToken: string) {
    let payload: any;
    try { payload = verifyToken(refreshToken); }
    catch { throw new Error('Invalid or expired refresh token'); }

    if(payload.type !== 'refresh') throw new Error('Invalid token type'); 

    const key    = `refresh:${payload.userId}:${refreshToken.slice(-20)}`;
    const stored = await redis.get(key) as string | null;
    if (!stored)                 throw new Error('Session expired. Please sign in again.');
    if (stored !== refreshToken) throw new Error('Token mismatch. Please sign in again.');
    await redis.del(key);

    const user = await db.query.users.findFirst({
      where:   eq(users.id, payload.userId),
      columns: { id: true, email: true, role: true, verified: true },
    });
    if (!user) throw new Error('User not found');

    const { accessToken: a, refreshToken: r } = await buildTokens({
      id: user.id, email: user.email, role: user.role as any,
      emailVerified: user.verified ?? false,
    });
    return { accessToken: a, refreshToken: r };
  }

  async logout(userId: string, refreshToken: string) {
    await redis.del(`refresh:${userId}:${refreshToken.slice(-20)}`);
  }

  async logoutAll(userId: string) {
    const keys = await redis.keys(`refresh:${userId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }

  async getMe(userId: string) {
    const user = await db.query.users.findFirst({
      where:   eq(users.id, userId),
      columns: { id: true, email: true, fullName: true, phone: true, role: true, verified: true, avatarUrl: true, createdAt: true },
    });
    if (!user) throw new Error('User not found');
    return user;
  }
}