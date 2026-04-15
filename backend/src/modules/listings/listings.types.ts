export type ListingStatus = 'draft' | 'active' | 'paused' | 'deleted';
export type PricingType   = 'per_hour' | 'per_day' | 'per_person' | 'package' | 'contact';

export interface ListingLocation {
  county:     string;
  area:       string;
  country?:   string;
  latitude?:  number;
  longitude?: number;
}

export interface ListingFilters {
  categoryId?:   string | undefined;
  categorySlug?: string | undefined;
  county?:       string | undefined;
  area?:         string | undefined;
  search?:       string | undefined;
  minPrice?:     number | undefined;
  maxPrice?:     number | undefined;
  vendorId?:     string | undefined;
  status?:       ListingStatus;
  limit?:        number;
  offset?:       number;
  sortBy?:       'price' | 'newest' | 'popular';
}

export interface ListingWithRelations {
  id:          string;
  title:       string;
  slug:        string;
  description: string;
  categoryId:  string;
  location:    ListingLocation;
  pricingType: PricingType;
  price?:      string;
  minPrice?:   string;
  maxPrice?:   string;
  currency:    string;
  photos:      string[];
  coverPhoto?: string;
  status:      ListingStatus;
  views:       number;
  bookingsCount: number;
  vendor?: {
    id:              string;
    businessName:    string;
    slug:            string;
    logo?:           string;
    whatsappNumber?: string;
    verified:        boolean;
  };
  category?: {
    id:    string;
    name:  string;
    slug:  string;
    icon?: string;
  };
}