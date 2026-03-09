export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'declined' | 'disputed';

export interface PricingBreakdown {
  baseAmount:  number;
  platformFee: number;
  vat:         number;
  totalAmount: number;
  pricingType: string;
  currency:    string;
  nights?:     number; // for per_day
  guests?:     number; // for per_person
}

export interface BookingFilters {
  status?:  BookingStatus | undefined;
  limit?:   number | undefined;
  offset?:  number | undefined;
}