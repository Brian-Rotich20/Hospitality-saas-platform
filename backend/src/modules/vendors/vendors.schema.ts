import { z } from 'zod';

const kenyanPhone = z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number');

export const updateVendorSchema = z.object({
  businessName: z.string().min(3).optional(),
  phoneNumber:  kenyanPhone.optional(),
  logo:         z.string().url().optional(),
});

export const payoutDetailsSchema = z.discriminatedUnion('payoutMethod', [
  z.object({ payoutMethod: z.literal('mpesa'), mpesaNumber: kenyanPhone }),
  z.object({
    payoutMethod:      z.literal('bank'),
    bankAccountName:   z.string().min(3),
    bankAccountNumber: z.string().min(5),
    bankName:          z.string().min(2),
  }),
]);

export type UpdateVendorInput  = z.infer<typeof updateVendorSchema>;
export type PayoutDetailsInput = z.infer<typeof payoutDetailsSchema>;