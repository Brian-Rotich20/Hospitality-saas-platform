export type ListingStatus = 'draft' | 'active' | 'paused' | 'deleted';
export type ListingCategory = 'event_venue' | 'catering' | 'accommodation' | 'other';

export interface ListingFilters {
  category?: ListingCategory;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  minCapacity?: number;
  search?: string;
  vendorId?: string;
  status?: ListingStatus;
  limit?: number;
  offset?: number;
}

export interface ListingWithVendor {
  id: string;
  title: string;
  slug: string;
  description: string;
  category: ListingCategory;
  location: string;
  basePrice: string;
  photos: string[];
  coverPhoto?: string;
  capacity?: number;
  amenities: string[];
  status: ListingStatus;
  vendor: {
    id: string;
    businessName: string;
  };
}