export type VendorStatus = 'approved' | 'suspended';

export interface VendorProfile {
  id: string;
  userId: string;
  businessName: string;
  slug: string;
  phoneNumber?: string;
  logo?: string;
  verified: boolean;
  payoutMethod?: string;
  mpesaNumber?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  bankName?: string;
  status: VendorStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VendorFilters {
  status?: VendorStatus;
  limit?: number;
  offset?: number;
}