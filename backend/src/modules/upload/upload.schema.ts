import { z } from 'zod';

export const uploadImageSchema = z.object({
  uploadType: z.enum(['listing_photo', 'profile_photo']),
  optimize: z.boolean().optional().default(true),
});

export const uploadDocumentSchema = z.object({
  uploadType: z.enum(['vendor_document']),
  documentType: z.enum(['business_registration', 'tax_pin', 'national_id', 'other']),
});

export const deleteFileSchema = z.object({
  publicId: z.string().optional(),
  url: z.string().optional(),
});

export type UploadImageInput = z.infer<typeof uploadImageSchema>;
export type UploadDocumentInput = z.infer<typeof uploadDocumentSchema>;
export type DeleteFileInput = z.infer<typeof deleteFileSchema>;