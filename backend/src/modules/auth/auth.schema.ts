import { z } from 'zod';

const kenyanPhone = z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number');

export const registerSchema = z.object({
  fullName: z.string().min(2, 'Full name must be at least 2 characters').max(100),
  email:    z.string().email('Invalid email address'),
  phone:    kenyanPhone,
  password: z.string().min(8, 'Password must be at least 8 characters'),
  intent:   z.enum(['customer', 'vendor']).optional().default('customer'), // ← ADD
});

export const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
});

export const refreshSchema = z.object({
  refreshToken: z.string(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput    = z.infer<typeof loginSchema>;
export type RefreshInput  = z.infer<typeof refreshSchema>;