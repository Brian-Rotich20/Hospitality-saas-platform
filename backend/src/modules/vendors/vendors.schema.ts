import { z } from 'zod';

// Vendor application schema
export const vendorApplicationSchema = z.object({
  businessName: z.string().min(3, 'Business name must be at least 3 characters').max(255),
  businessType: z.enum(['event_venue', 'catering', 'accommodation', 'other']),
  businessRegistration: z.string().optional(),
  taxPin: z.string().regex(/^[A-Z]\d{9}[A-Z]$/, 'Invalid KRA PIN format (e.g., A123456789Z)').optional(),
  phoneNumber: z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number'),
  location: z.string().min(3, 'Location is required'),
  description: z.string().min(20, 'Description must be at least 20 characters').max(1000),
});

// Payout details schema
export const payoutDetailsSchema = z.object({
  payoutMethod: z.enum(['mpesa', 'bank']),
  mpesaNumber: z.string().regex(/^(\+254|0)[17]\d{8}$/).optional(),
  bankAccountName: z.string().min(3).optional(),
  bankAccountNumber: z.string().min(5).optional(),
  bankName: z.string().min(2).optional(),
}).refine(
  (data) => {
    if (data.payoutMethod === 'mpesa') {
      return !!data.mpesaNumber;
    }
    if (data.payoutMethod === 'bank') {
      return !!data.bankAccountName && !!data.bankAccountNumber && !!data.bankName;
    }
    return true;
  },
  {
    message: 'Payout details are incomplete for selected method',
  }
);

// Update vendor profile schema
export const updateVendorSchema = z.object({
  businessName: z.string().min(3).max(255).optional(),
  businessType: z.enum(['event_venue', 'catering', 'accommodation', 'other']).optional(),
  phoneNumber: z.string().regex(/^(\+254|0)[17]\d{8}$/).optional(),
  location: z.string().min(3).optional(),
  description: z.string().min(20).max(1000).optional(),
});

// Admin approval/rejection schema
export const vendorReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().min(10).optional(),
}).refine(
  (data) => {
    if (data.status === 'rejected') {
      return !!data.rejectionReason;
    }
    return true;
  },
  {
    message: 'Rejection reason is required when rejecting vendor',
  }
);

export type VendorApplicationInput = z.infer<typeof vendorApplicationSchema>;
export type PayoutDetailsInput = z.infer<typeof payoutDetailsSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
export type VendorReviewInput = z.infer<typeof vendorReviewSchema>;