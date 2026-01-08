import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  phone: z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['customer', 'vendor']).default('customer'),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

export const verifyOTPSchema = z.object({
  phone: z.string(),
  otp: z.string().length(6),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;