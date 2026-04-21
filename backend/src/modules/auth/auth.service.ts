import { eq } from 'drizzle-orm';
import { db } from '../../config/database';
import { users, vendors } from '../../db/schema';
import { hashPassword, comparePassword } from '../../utils/password';
import { redis } from '../../config/redis';
import type { RegisterInput, LoginInput } from './auth.schema';
import jwt from 'jsonwebtoken';
import { signAccessToken, signRefreshToken, verifyToken } from '../../utils/jwt';

const JWT_SECRET         = process.env.JWT_SECRET!;
const ACCESS_TOKEN_TTL   = '15m';
const REFRESH_TOKEN_TTL  = '7d';
const REFRESH_TTL_SECS   = 60 * 60 * 24 * 7; // 7 days in seconds for Redis


// ── Safe user object — never expose passwordHash ──────────────────────────────

function safeUser(user: any) {
  const { passwordHash, ...safe } = user;
  return safe;
}

export class AuthService {

  // ── Register ──────────────────────────────────────────────────────────────────

  async register(data: RegisterInput) {
    const existing = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });
    if (existing) throw new Error('An account with this email already exists');

    const passwordHash = await hashPassword(data.password);

    const [user] = await db.insert(users).values({
      fullName:     data.fullName,
      email:        data.email,
      phone:        data.phone,
      passwordHash,
      role:         'customer', // always customer on register
    }).returning({
      id:       users.id,
      email:    users.email,
      fullName: users.fullName,
      phone:    users.phone,
      role:     users.role,
    });

    if (!user) throw new Error('Registration failed');

    const tokenPayload = { userId: user.id, email: user.email, role: user.role };
    const accessToken  = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    // Store refresh token in Redis — keyed by userId so we can revoke all sessions
    await redis.setex(`refresh:${user.id}:${refreshToken.slice(-20)}`, REFRESH_TTL_SECS, refreshToken);

    return { user, accessToken, refreshToken };
  }

  // ── Login ─────────────────────────────────────────────────────────────────────
  async login(data: LoginInput) {
    const user = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });

    if (!user) throw new Error('Invalid email or password');

    // Account was created via Google — has no password
    if (!user.passwordHash) {
      throw new Error('This account uses Google sign-in. Please continue with Google.');
    }

    const valid = await comparePassword(data.password, user.passwordHash);
    if (!valid) throw new Error('Invalid email or password');

    let vendorId: string | undefined;
    if (user.role === 'vendor') {
      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.userId, user.id),
        columns: { id: true },
      });
      vendorId = vendor?.id;
    }

    const tokenPayload = { userId: user.id, email: user.email, role: user.role, vendorId };
    const accessToken  = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    await redis.setex(`refresh:${user.id}:${refreshToken.slice(-20)}`, REFRESH_TTL_SECS, refreshToken);

    return { user: safeUser(user), accessToken, refreshToken };
  }

  // ── Refresh token ─────────────────────────────────────────────────────────────

  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = verifyToken(refreshToken);
    } catch {
      throw new Error('Invalid or expired refresh token');
    }

    const key = `refresh:${payload.userId}:${refreshToken.slice(-20)}`;

    // Check existence first WITHOUT deleting
    const stored = await redis.get(key) as string | null;
    if (!stored)                throw new Error('Refresh token has been revoked');
    if (stored !== refreshToken) throw new Error('Refresh token mismatch');

    // Now delete and rotate atomically
    await redis.del(key);

    const user = await db.query.users.findFirst({
      where: eq(users.id, payload.userId),
      columns: { id: true, email: true, role: true },
    });
    if (!user) throw new Error('User not found');

    const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await buildTokens(user);
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  }

  // ── Logout ────────────────────────────────────────────────────────────────────

  async logout(userId: string, refreshToken: string) {
    const key = `refresh:${userId}:${refreshToken.slice(-20)}`;
    await redis.del(key);
  }

  // ── Logout all devices ────────────────────────────────────────────────────────

  async logoutAll(userId: string) {
    const keys = await redis.keys(`refresh:${userId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }

  // ── Get current user ──────────────────────────────────────────────────────────

  async getMe(userId: string) {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true, email: true, fullName: true,
        phone: true, role: true, verified: true,
        avatarUrl: true, createdAt: true,
      },
    });
    if (!user) throw new Error('User not found');
    return user;
  }

  // ── Google OAuth ──────────────────────────────────────────────────────────────
async googleAuth(profile: {
  googleId:  string;
  email:     string;
  fullName:  string;
  avatarUrl: string | undefined;   // ← was: avatarUrl?: string
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
        .set({ googleId: profile.googleId, ...(profile.avatarUrl && { avatarUrl: profile.avatarUrl }) })
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
      ...(profile.avatarUrl && { avatarUrl: profile.avatarUrl }),
      role:      'customer',
      verified:  true,
    }).returning();
    user = rows[0];
  }

  // After all branches user must exist
  if (!user) throw new Error('Failed to create or find user');

  let vendorId: string | undefined;
  if (user.role === 'vendor') {
    const vendorRow = await db.query.vendors.findFirst({  // renamed to avoid collision
      where: eq(vendors.userId, user.id),
      columns: { id: true },
    });
    vendorId = vendorRow?.id;
  }

  const tokenPayload = { userId: user.id, email: user.email, role: user.role, vendorId };
  const accessToken  = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);

  await redis.setex(`refresh:${user.id}:${refreshToken.slice(-20)}`, REFRESH_TTL_SECS, refreshToken);

  return { user: safeUser(user), accessToken, refreshToken };
}
}

function buildTokens(user: { email: string; id: string; role: "customer" | "vendor" | "admin"; }): { accessToken: any; refreshToken: any; } | PromiseLike<{ accessToken: any; refreshToken: any; }> {
  throw new Error('Function not implemented.');
}
