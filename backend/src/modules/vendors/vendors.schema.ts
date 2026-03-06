import { z } from 'zod';

const kenyanPhone = z.string().regex(/^(\+254|0)[17]\d{8}$/, 'Invalid Kenyan phone number');
const kraPIN      = z.string().regex(/^[A-Z]\d{9}[A-Z]$/, 'Invalid KRA PIN format (e.g., A123456789Z)');

// ─── Apply as vendor ──────────────────────────────────────────────────────────
export const vendorApplicationSchema = z.object({
  businessName:         z.string().min(3, 'Business name must be at least 3 characters').max(255),
  description:          z.string().min(20, 'Description must be at least 20 characters').max(1000),
  phoneNumber:          kenyanPhone,
  whatsappNumber:       kenyanPhone.optional(),

  // ✅ No businessType — categories handle this now
  businessRegistration: z.string().optional(),
  taxPin:               kraPIN.optional(),

  // ✅ city + county replace flat location string
  city:   z.string().min(2, 'City is required'),
  county: z.string().optional(),

  email:   z.string().email().optional(),
  website: z.string().url().optional(),
});

// ─── Update vendor profile ────────────────────────────────────────────────────
export const updateVendorSchema = z.object({
  businessName:   z.string().min(3).max(255).optional(),
  description:    z.string().min(20).max(1000).optional(),
  phoneNumber:    kenyanPhone.optional(),
  whatsappNumber: kenyanPhone.optional(),
  email:          z.string().email().optional(),
  website:        z.string().url().optional(),
  city:           z.string().min(2).optional(),
  county:         z.string().optional(),
  logo:           z.string().url().optional(),
  coverPhoto:     z.string().url().optional(),
});

// ─── Payout details ───────────────────────────────────────────────────────────
export const payoutDetailsSchema = z.object({
  payoutMethod:      z.enum(['mpesa', 'bank']),
  mpesaNumber:       kenyanPhone.optional(),
  bankAccountName:   z.string().min(3).optional(),
  bankAccountNumber: z.string().min(5).optional(),
  bankName:          z.string().min(2).optional(),
}).refine(data => {
  if (data.payoutMethod === 'mpesa') return !!data.mpesaNumber;
  if (data.payoutMethod === 'bank')  return !!data.bankAccountName && !!data.bankAccountNumber && !!data.bankName;
  return true;
}, { message: 'Payout details are incomplete for selected method' });

// ─── Admin review ─────────────────────────────────────────────────────────────
export const vendorReviewSchema = z.object({
  status:          z.enum(['approved', 'rejected']),
  rejectionReason: z.string().min(10).optional(),
}).refine(data => {
  if (data.status === 'rejected') return !!data.rejectionReason;
  return true;
}, { message: 'Rejection reason is required when rejecting a vendor' });

export type VendorApplicationInput = z.infer<typeof vendorApplicationSchema>;
export type UpdateVendorInput      = z.infer<typeof updateVendorSchema>;
export type PayoutDetailsInput     = z.infer<typeof payoutDetailsSchema>;
export type VendorReviewInput      = z.infer<typeof vendorReviewSchema>;