// src/modules/vendors/vendors.schema.ts
// ✅ Pure Zod schemas — no DB imports, no circular dependencies

import { z } from 'zod';

const kenyanPhone = z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number');

export const vendorApplicationSchema = z.object({
  businessName:         z.string().min(3,  'Business name must be at least 3 characters'),
  description:          z.string().min(20, 'Description must be at least 20 characters'),
  phoneNumber:          kenyanPhone,
  whatsappNumber:       kenyanPhone.optional(),
  businessRegistration: z.string().optional(),
  taxPin:               z.string().optional(),
  city:                 z.string().min(2, 'City is required'),
  county:               z.string().optional(),
  email:                z.string().email().optional(),
  website:              z.string().url().optional().or(z.literal('')),
});

export const updateVendorSchema = z.object({
  businessName:   z.string().min(3).optional(),
  description:    z.string().min(20).optional(),
  phoneNumber:    kenyanPhone.optional(),
  whatsappNumber: kenyanPhone.optional(),
  city:           z.string().min(2).optional(),
  county:         z.string().optional(),
  logo:           z.string().url().optional(),
  coverImage:     z.string().url().optional(),
  website:        z.string().url().optional().or(z.literal('')),
  socialLinks:    z.record(z.string(), z.string()).optional(),
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

// ✅ vendorReviewSchema — used by PUT /admin/vendors/:id/review
// Only status and optional rejectionReason — no DB references
export const vendorReviewSchema = z.object({
  status:          z.enum(['approved', 'rejected']),
  rejectionReason: z.string().min(10, 'Please provide a reason (min 10 chars)').optional(),
});

export type VendorApplicationInput = z.infer<typeof vendorApplicationSchema>;
export type UpdateVendorInput      = z.infer<typeof updateVendorSchema>;
export type PayoutDetailsInput     = z.infer<typeof payoutDetailsSchema>;
export type VendorReviewInput      = z.infer<typeof vendorReviewSchema>;