import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { users, vendors } from '../../db/schema';
import { hashPassword, comparePassword } from '../../utils/password';
import { redis } from '../../config/redis';
import type { RegisterInput, LoginInput } from './auth.schema';
import { signAccessToken, signRefreshToken, verifyToken } from '../../utils/jwt';

const REFRESH_TTL_SECS = 60 * 60 * 24 * 7;

function safeUser(user: any) {
  const { passwordHash, ...safe } = user;
  return safe;
}

async function buildTokens(user: { id: string; email: string; role: 'customer' | 'vendor' | 'admin' }) {
  let vendorId: string | undefined;
  if (user.role === 'vendor') {
    const row = await db.query.vendors.findFirst({
      where:   eq(vendors.userId, user.id),
      columns: { id: true },
    });
    vendorId = row?.id;
  }

  const payload = {
    userId:   user.id,
    email:    user.email,
    role:     user.role,
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

export class AuthService {

  async register(data: RegisterInput) {
    const existing = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });

    if (existing) {
      // Google account — allow linking password
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
            fullName: users.fullName, phone: users.phone, role: users.role,
          });
        if (!updated) throw new Error('Failed to link account. Please try again.');
        const { accessToken, refreshToken } = await buildTokens(updated);
        return { user: updated, accessToken, refreshToken };
      }
      throw new Error('An account with this email already exists. Please sign in.');
    }

    try {
      const passwordHash = await hashPassword(data.password);

      // ✅ Set role=vendor immediately if intent=vendor
      // Vendor is still gated by vendor.status = 'pending_verification'
      // Role just controls routing — not actual feature access
      const role = data.intent === 'vendor' ? 'vendor' : 'customer';

      const [user] = await db.insert(users).values({
        fullName: data.fullName,
        email:    data.email,
        phone:    data.phone,
        passwordHash,
        role,
      }).returning({
        id:       users.id,
        email:    users.email,
        fullName: users.fullName,
        phone:    users.phone,
        role:     users.role,
      });

      if (!user) throw new Error('Registration failed. Please try again.');

      const { accessToken, refreshToken } = await buildTokens(user);
      return { user, accessToken, refreshToken };

    } catch (err: any) {
      if (err.message?.includes('unique') || err.code === '23505') {
        if (err.message?.includes('phone')) {
          throw new Error('This phone number is already registered. Please use a different number or sign in.');
        }
        if (err.message?.includes('email')) {
          throw new Error('An account with this email already exists. Please sign in.');
        }
        throw new Error('An account with these details already exists.');
      }
      throw err;
    }
  }

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

    const { accessToken, refreshToken } = await buildTokens(user);
    return { user: safeUser(user), accessToken, refreshToken };
  }

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
            verified: true,
            ...(!existing.avatarUrl && profile.avatarUrl
              ? { avatarUrl: profile.avatarUrl }
              : {}),
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
        verified:  true,
      }).returning();
      user = rows[0];
    }

    if (!user) throw new Error('Failed to create or retrieve user account.');

    const { accessToken, refreshToken } = await buildTokens(user);
    return { user: safeUser(user), accessToken, refreshToken };
  }

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
      columns: { id: true, email: true, role: true },
    });
    if (!user) throw new Error('User not found');

    const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await buildTokens(user);
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
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