// src/modules/auth/auth.service.ts
import { eq } from 'drizzle-orm';
import { db }  from '../../config/database';
import { users, vendors }      from '../../db/schema';
import { hashPassword, comparePassword } from '../../utils/password';
import { redis }               from '../../config/redis';
import { sendCustomerVerificationEmail } from '../../utils/email';
import type { RegisterInput, LoginInput } from './auth.schema';
import { signAccessToken, signRefreshToken, verifyToken } from '../../utils/jwt';

const REFRESH_TTL_SECS = 60 * 60 * 24 * 7;   // 7 days
const OTP_TTL          = 15 * 60;             // 15 minutes
const OTP_RESEND_WAIT  = 60;                  // seconds before resend allowed

function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function safeUser(user: any) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// ── Build JWT pair ─────────────────────────────────────────────────────────────
// emailVerified is embedded in the token so the middleware can read it
// without a DB round-trip on every request.
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
  await redis.setex(key, OTP_TTL, JSON.stringify({ otp, attempts: 0 }));

  setImmediate(() => {
    sendCustomerVerificationEmail({ to: email, fullName, otp })
      .catch(err => console.error('[Customer OTP email failed]', err?.message));
  });
}

export class AuthService {

  // ── Register ────────────────────────────────────────────────────────────────
  async register(data: RegisterInput) {
    const existing = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });

    if (existing) {
      // Google account — allow linking a password
      if (!existing.passwordHash && existing.googleId) {
        const passwordHash = await hashPassword(data.password);
        const [updated] = await db.update(users)
          .set({
            passwordHash,
            fullName:  data.fullName ?? existing.fullName,
            phone:     data.phone    ?? existing.phone,
            updatedAt: new Date(),
          })
          .where(eq(users.id, existing.id))
          .returning({
            id: users.id, email: users.email,
            fullName: users.fullName, phone: users.phone,
            role: users.role, verified: users.verified,
          });
        if (!updated) throw new Error('Failed to link account. Please try again.');

        // Google accounts are already verified
        const { accessToken, refreshToken } = await buildTokens({
          ...updated,
          emailVerified: updated.verified ?? true,
        });
        return { user: updated, accessToken, refreshToken, requiresVerification: false };
      }
      throw new Error('An account with this email already exists. Please sign in.');
    }

    try {
      const passwordHash = await hashPassword(data.password);
      const role = data.intent === 'vendor' ? 'vendor' : 'customer';

      const [user] = await db.insert(users).values({
        fullName:     data.fullName,
        email:        data.email,
        phone:        data.phone,
        passwordHash,
        role,
        verified:     false,   // ← must verify email before accessing app
      }).returning({
        id:       users.id,
        email:    users.email,
        fullName: users.fullName,
        phone:    users.phone,
        role:     users.role,
        verified: users.verified,
      });

      if (!user) throw new Error('Registration failed. Please try again.');

      // Send OTP — non-blocking (setImmediate inside sendCustomerOTP)
      await sendCustomerOTP(user.id, user.email, user.fullName ?? 'there');

      // Issue token with emailVerified=false — middleware will redirect to verify
      const { accessToken, refreshToken } = await buildTokens({
        ...user,
        emailVerified: false,
      });

      return { user, accessToken, refreshToken, requiresVerification: true };

    } catch (err: any) {
      if (err.message?.includes('unique') || err.code === '23505') {
        if (err.message?.includes('phone')) {
          throw new Error('This phone number is already registered.');
        }
        if (err.message?.includes('email')) {
          throw new Error('An account with this email already exists. Please sign in.');
        }
        throw new Error('An account with these details already exists.');
      }
      throw err;
    }
  }

  // ── Verify customer OTP ────────────────────────────────────────────────────
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

    // ✅ OTP correct — mark user as verified
    await redis.del(key);

    const [user] = await db.update(users)
      .set({ verified: true, updatedAt: new Date() })
      .where(eq(users.id, userId))
      .returning({
        id:       users.id,
        email:    users.email,
        fullName: users.fullName,
        phone:    users.phone,
        role:     users.role,
        verified: users.verified,
      });

    if (!user) throw new Error('User not found.');

    // Issue fresh token with emailVerified=true — middleware unlocks all routes
    const { accessToken, refreshToken } = await buildTokens({
      ...user,
      emailVerified: true,
    });

    return { user, accessToken, refreshToken };
  }

  // ── Resend customer OTP ────────────────────────────────────────────────────
  async resendCustomerOTP(userId: string) {
    const user = await db.query.users.findFirst({
      where:   eq(users.id, userId),
      columns: { id: true, email: true, fullName: true, verified: true },
    });
    if (!user)          throw new Error('User not found.');
    if (user.verified)  throw new Error('Email is already verified.');

    // Rate limit — 60 second cooldown
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

  // ── Login — blocks unverified users ───────────────────────────────────────
  async login(data: LoginInput) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });

    if (!user) throw new Error('Invalid email or password');

    if (!user.passwordHash) {
      throw new Error('This account uses Google sign-in. Please click "Continue with Google".');
    }

    const valid = await comparePassword(data.password, user.passwordHash);
    if (!valid) throw new Error('Invalid email or password');

    // ── Enforce email verification ─────────────────────────────────────────
    if (!user.verified) {
      // Re-send OTP so the user can complete verification immediately
      await sendCustomerOTP(user.id, user.email, user.fullName ?? 'there')
        .catch(() => {}); // fire and forget — don't fail login response

      const { accessToken } = await buildTokens({
        id:            user.id,
        email:         user.email,
        role:          user.role as any,
        emailVerified: false,
      });

      // Return 403-style data — controller will send 403
      throw Object.assign(
        new Error('Please verify your email before signing in. We just sent you a new code.'),
        { code: 'EMAIL_NOT_VERIFIED', accessToken },
      );
    }

    const { accessToken, refreshToken } = await buildTokens({
      id:            user.id,
      email:         user.email,
      role:          user.role as any,
      emailVerified: true,
    });
    return { user: safeUser(user), accessToken, refreshToken };
  }

  // ── Google auth — Google accounts skip email verification ─────────────────
  async googleAuth(profile: {
    googleId:  string;
    email:     string;
    fullName:  string;
    avatarUrl: string | undefined;
  }) {
    let user = await db.query.users.findFirst({
      where: eq(users.googleId, profile.googleId),
    });

    if (!user) {
      const existing = await db.query.users.findFirst({
        where: eq(users.email, profile.email),
      });
      if (existing) {
        const rows = await db.update(users)
          .set({
            googleId: profile.googleId,
            verified: true,  // Google-verified email
            ...(!existing.avatarUrl && profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
          })
          .where(eq(users.id, existing.id))
          .returning();
        user = rows[0];
      }
    }

    if (!user) {
      const rows = await db.insert(users).values({
        fullName:  profile.fullName,
        email:     profile.email,
        googleId:  profile.googleId,
        avatarUrl: profile.avatarUrl ?? null,
        role:      'customer',
        verified:  true,   // Google accounts are pre-verified
      }).returning();
      user = rows[0];
    }

    if (!user) throw new Error('Failed to create or retrieve user account.');

    const { accessToken, refreshToken } = await buildTokens({
      id:            user.id,
      email:         user.email,
      role:          user.role as any,
      emailVerified: true,
    });
    return { user: safeUser(user), accessToken, refreshToken };
  }

  // ── Refresh token ──────────────────────────────────────────────────────────
  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = verifyToken(refreshToken);
    } catch {
      throw new Error('Invalid or expired refresh token');
    }

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

    const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await buildTokens({
      id:            user.id,
      email:         user.email,
      role:          user.role as any,
      emailVerified: user.verified ?? false,
    });
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  }

  // ── Logout ─────────────────────────────────────────────────────────────────
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
      columns: {
        id: true, email: true, fullName: true,
        phone: true, role: true, verified: true,
        avatarUrl: true, createdAt: true,
      },
    });
    if (!user) throw new Error('User not found');
    return user;
  }
}