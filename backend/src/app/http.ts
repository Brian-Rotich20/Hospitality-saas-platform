// Shared request schemas and response helpers.
import { z } from 'zod';

export const uuidParam = (name = 'id') => z.object({ [name]: z.string().uuid() });
export const idParams = z.object({ id: z.string().uuid() });

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const idempotencyHeaders = z.object({
  'idempotency-key': z.string().min(8).max(100).regex(/^[A-Za-z0-9_\-:.]+$/).optional(),
}).passthrough();

export function ok<T>(data: T, extra: Record<string, unknown> = {}) {
  return { success: true as const, data, ...extra };
}
