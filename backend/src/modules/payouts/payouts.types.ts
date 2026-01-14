export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface PayoutCalculation {
  grossAmount: number;
  platformFee: number;
  vat: number;
  withholdingTax: number;
  netAmount: number;
}