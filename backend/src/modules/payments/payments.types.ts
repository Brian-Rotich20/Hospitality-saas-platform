export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded';
export type PaymentMethod = 'mpesa' | 'card' | 'bank_transfer';

export interface MpesaPaymentRequest {
  phoneNumber: string;
  amount: number;
  bookingId: string;
}

export interface FlutterwaveResponse {
  status: string;
  message: string;
  data: {
    link?: string;
    id?: number;
    tx_ref?: string;
  };
}

export interface WebhookPayload {
  event: string;
  data: {
    id: number;
    tx_ref: string;
    flw_ref: string;
    amount: number;
    currency: string;
    charged_amount: number;
    status: string;
    payment_type: string;
    customer: {
      phone_number: string;
      email: string;
    };
  };
}