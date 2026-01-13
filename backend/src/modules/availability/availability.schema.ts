import { z } from 'zod';

export const blockDatesSchema = z.object({
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')),
  reason: z.string().optional(),
});

export const unblockDatesSchema = z.object({
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')),
});

export const checkAvailabilitySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
});

export const getCalendarSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type BlockDatesInput = z.infer<typeof blockDatesSchema>;
export type UnblockDatesInput = z.infer<typeof unblockDatesSchema>;
export type CheckAvailabilityInput = z.infer<typeof checkAvailabilitySchema>;
export type GetCalendarInput = z.infer<typeof getCalendarSchema>;