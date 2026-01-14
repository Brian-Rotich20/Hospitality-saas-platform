import { z } from 'zod';

export const triggerPayoutSchema = z.object({
  bookingId: z.string().uuid(),
});

export const getPayoutsSchema = z.object({
  status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export type TriggerPayoutInput = z.infer<typeof triggerPayoutSchema>;
export type GetPayoutsInput = z.infer<typeof getPayoutsSchema>;