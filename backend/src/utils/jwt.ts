import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export interface JWTPayload {
  userId: string;
  email: string;
  role: 'customer' | 'vendor' | 'admin';
}

export const signToken = (payload: JWTPayload): string => {
  return jwt.sign(payload, env.JWT_SECRET as string, { expiresIn: env.JWT_EXPIRES_IN } as SignOptions);
};

export const verifyToken = (token: string): JWTPayload => {
  return jwt.verify(token, env.JWT_SECRET as Secret) as JWTPayload;
};