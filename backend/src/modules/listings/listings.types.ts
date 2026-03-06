// listings.types.ts

export type ListingStatus   = 'draft' | 'active' | 'paused' | 'deleted';
export type PricingType     = 'fixed' | 'per_day' | 'per_hour' | 'per_person' | 'range' | 'package';

export interface ListingLocation {
  address?:   string;
  city:       string;
  county?:    string;
  country?:   string;
  latitude?:  number;
  longitude?: number;
}

export interface ListingFilters {
  categoryId?: string | undefined;       // ✅ dynamic FK — not hardcoded enum
  categorySlug?: string | undefined;     // alternative filter by slug
  city?: string | undefined;             // ✅ query inside jsonb location
  search?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  minCapacity?: number | undefined;
  vendorId?: string | undefined;
  status?: ListingStatus;
  limit?: number | undefined;
  offset?: number | undefined;
  sortBy?: 'price' | 'rating' | 'newest' | 'popular';
}

export interface ListingWithRelations {
  id: string;
  title: string;
  slug: string;
  description: string;
  categoryId: string;
  location: ListingLocation;
  pricingType: PricingType;
  price?: string;
  minPrice?: string;
  maxPrice?: string;
  currency: string;
  photos: string[];
  coverPhoto?: string;
  capacity?: number;
  amenities?: string[];
  status: ListingStatus;
  views: number;
  bookingsCount: number;
  vendor?: {
    id: string;
    businessName: string;
    slug: string;
    logo?: string;
    whatsappNumber?: string;
    verified: boolean;
  };
  category?: {
    id: string;
    name: string;
    slug: string;
    icon?: string;
  };
}