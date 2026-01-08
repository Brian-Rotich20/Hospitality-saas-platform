export type VendorStatus = 'pending' | 'approved' | 'rejected' | 'suspended';
export type BusinessType = 'event_venue' | 'catering' | 'accommodation' | 'other';

export interface VendorProfile {
  id: string;
  userId: string;
  businessName: string;
  businessType: BusinessType;
  businessRegistration?: string;
  taxPin?: string;
  mpesaNumber?: string;
  bankAccountName?: string;
  bankAccountNumber?: string;
  bankName?: string;
  status: VendorStatus;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VendorDocument {
  id: string;
  vendorId: string;
  documentType: 'business_registration' | 'tax_pin' | 'national_id' | 'other';
  documentUrl: string;
  uploadedAt: Date;
}