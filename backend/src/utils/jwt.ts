// utils/jwt.ts — add refresh token signing here so everything is in one place

import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface JWTPayload {
  userId:    string;
  email:     string;
  role:      'customer' | 'vendor' | 'admin';
  vendorId?: string | undefined;   // ✅ optional — only vendors have this
  fullName?: string | undefined;   // ✅ optional too
}

const ACCESS_TTL  = '15m';
const REFRESH_TTL = '7d';

export const signAccessToken = (payload: JWTPayload): string =>
  jwt.sign(payload, env.JWT_SECRET as Secret, { expiresIn: ACCESS_TTL } as SignOptions);

export const signRefreshToken = (payload: JWTPayload): string =>
  jwt.sign(payload, env.JWT_SECRET as Secret, { expiresIn: REFRESH_TTL } as SignOptions);

export const verifyToken = (token: string): JWTPayload =>
  jwt.verify(token, env.JWT_SECRET as Secret) as JWTPayload;