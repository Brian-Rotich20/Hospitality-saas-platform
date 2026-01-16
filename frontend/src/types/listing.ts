export interface Listing {
  id: string;
  title: string;
  slug: string;
  description: string;
  category: 'event_venue' | 'catering' | 'accommodation';
  location: string;
  address: string;
  county?: string;
  city?: string;
  capacity?: number;
  basePrice: string;
  coverPhoto?: string;
  photos: string[];
  amenities: string[];
  status: 'draft' | 'active' | 'paused';
  rating?: number;
  vendor: {
    id: string;
    businessName: string;
  };
}

export interface ListingFilters {
  category?: string;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
  limit?: number;
  offset?: number;
}