// vendors.types.ts

export type VendorStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

export interface VendorProfile {
  id: string;
  userId: string;
  businessName: string;
  slug: string;
  description: string;
  businessRegistration?: string;
  taxPin?: string;
  phoneNumber: string;
  whatsappNumber?: string;
  email?: string;
  website?: string;
  city?: string;
  county?: string;
  logo?: string;
  coverPhoto?: string;
  verified: boolean;
  payoutMethod?: string;
  mpesaNumber?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  bankName?: string;
  status: VendorStatus;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VendorDocument {
  id: string;
  vendorId: string;
  documentType: 'business_registration' | 'tax_pin' | 'national_id' | 'other';
  documentUrl: string;
  fileName: string;
  fileSize?: string;
  uploadedAt: string;
}

export interface VendorFilters {
  status?: VendorStatus;
  limit?: number | undefined;
  offset?: number | undefined;
}