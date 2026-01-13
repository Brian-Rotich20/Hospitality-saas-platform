export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled' | 'declined' | 'disputed';

export interface PricingBreakdown {
  baseAmount: number;
  platformFee: number;
  vat: number;
  totalAmount: number;
}