// vendors.schema.ts
import { z } from 'zod';

const kenyanPhone = z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number');

export const vendorApplicationSchema = z.object({
  businessName:   z.string().min(3, 'Business name must be at least 3 characters'),
  description:    z.string().min(20).max(500).optional(),
  phoneNumber:    kenyanPhone.optional(),
  whatsappNumber: kenyanPhone.optional(),
  website:        z.string().url().optional().or(z.literal('')),
});
// Onboarding steps use updateVendorSchema — add these fields:
export const updateVendorSchema = z.object({
  businessName:         z.string().min(3).optional(),
  description:          z.string().min(20).max(500).optional(),
  phoneNumber:          kenyanPhone.optional(),
  whatsappNumber:       kenyanPhone.optional(),
  city:                 z.string().min(2).optional(),
  county:               z.string().optional(),
  logo:                 z.string().url().optional(),
  coverImage:           z.string().url().optional(),
  website:              z.string().url().optional().or(z.literal('')),
  socialLinks:          z.record(z.string(), z.string()).optional(),
  businessRegistration: z.string().optional(),
  taxPin:               z.string().optional(),
  email:                z.string().email().optional(),
  onboardingStep:       z.number().int().min(0).max(5).optional(),
});

export const payoutDetailsSchema = z.discriminatedUnion('payoutMethod', [
  z.object({
    payoutMethod: z.literal('mpesa'),
    mpesaNumber:  kenyanPhone,
  }),
  z.object({
    payoutMethod:      z.literal('bank'),
    bankAccountName:   z.string().min(3),
    bankAccountNumber: z.string().min(5),
    bankName:          z.string().min(2),
  }),
]);


export type VendorApplicationInput = z.infer<typeof vendorApplicationSchema>;
export type UpdateVendorInput      = z.infer<typeof updateVendorSchema>;
export type PayoutDetailsInput     = z.infer<typeof payoutDetailsSchema>;
