import axios from 'axios';
import { eq, and, lte, inArray, sql } from 'drizzle-orm';
import { db } from '../../config/database';
import { payouts, bookings, vendors } from '../../db/schema';
import { env } from '../../config/env';
import type { PayoutCalculation } from './payouts.types';

export class PayoutService {
  private readonly PLATFORM_FEE_PERCENT = 0.15; // 15%
  private readonly VAT_PERCENT = 0.16; // 16%
  private readonly WITHHOLDING_TAX_PERCENT = 0.05; // 5%
  private readonly FLUTTERWAVE_BASE_URL = 'https://api.flutterwave.com/v3';

  // Calculate payout breakdown
  private calculatePayout(baseAmount: number): PayoutCalculation {
    const grossAmount = baseAmount;
    const platformFee = grossAmount * this.PLATFORM_FEE_PERCENT;
    const vat = platformFee * this.VAT_PERCENT;
    const withholdingTax = grossAmount * this.WITHHOLDING_TAX_PERCENT;
    const netAmount = grossAmount - platformFee - withholdingTax;

    return {
      grossAmount: parseFloat(grossAmount.toFixed(2)),
      platformFee: parseFloat(platformFee.toFixed(2)),
      vat: parseFloat(vat.toFixed(2)),
      withholdingTax: parseFloat(withholdingTax.toFixed(2)),
      netAmount: parseFloat(netAmount.toFixed(2)),
    };
  }

  // Create payout for completed booking
  async createPayoutForBooking(bookingId: string) {
    // Get booking
    const booking = await db.query.bookings.findFirst({
      where: eq(bookings.id, bookingId),
      with: {
        listing: {
          with: {
            vendor: true,
          },
        },
      },
    });

    if (!booking) {
      throw new Error('Booking not found');
    }

    if (booking.status !== 'completed') {
      throw new Error('Only completed bookings can be paid out');
    }

    // Check if payout already exists
    const existingPayout = await db.query.payouts.findFirst({
      where: eq(payouts.bookingId, bookingId),
    });

    if (existingPayout) {
      throw new Error('Payout already created for this booking');
    }

    // Calculate payout
    const calculation = this.calculatePayout(parseFloat(booking.baseAmount));

    // Get vendor payout details
    const vendor = booking.listing.vendor;
    const payoutMethod = vendor.payoutMethod || 'mpesa';
    const accountDetails = payoutMethod === 'mpesa' 
      ? vendor.mpesaNumber 
      : `${vendor.bankName} - ${vendor.bankAccountNumber}`;

    if (!accountDetails) {
      throw new Error('Vendor payout details not configured');
    }

    // Schedule payout for 48 hours after booking completion
    const scheduledAt = new Date();
    scheduledAt.setHours(scheduledAt.getHours() + 48);

    // Create payout
    const payoutResult = await db.insert(payouts).values({
      vendorId: vendor.id,
      bookingId: bookingId,
      grossAmount: calculation.grossAmount.toString(),
      platformFee: calculation.platformFee.toString(),
      vat: calculation.vat.toString(),
      withholdingTax: calculation.withholdingTax.toString(),
      netAmount: calculation.netAmount.toString(),
      status: 'pending',
      payoutMethod,
      accountDetails,
      scheduledAt,
    }).returning();

    if (!payoutResult[0]) {
      throw new Error('Failed to create payout');
    }

    return payoutResult[0];
  }

  // Process M-Pesa payout via Flutterwave
  private async processMpesaPayout(payout: any) {
    try {
      const response = await axios.post(
        `${this.FLUTTERWAVE_BASE_URL}/transfers`,
        {
          account_bank: 'MPS',
          account_number: payout.accountDetails,
          amount: parseFloat(payout.netAmount),
          currency: 'KES',
          narration: `Payout for booking ${payout.bookingId}`,
          reference: `PAYOUT-${payout.id}`,
          beneficiary_name: 'Vendor',
        },
        {
          headers: {
            Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      return {
        success: true,
        reference: response.data.data.reference,
        response: response.data,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        response: error.response?.data,
      };
    }
  }

  // Process single payout
  async processPayout(payoutId: string) {
    const payout = await db.query.payouts.findFirst({
      where: eq(payouts.id, payoutId),
      with: {
        vendor: true,
      },
    });

    if (!payout) {
      throw new Error('Payout not found');
    }

    if (payout.status !== 'pending') {
      throw new Error(`Cannot process payout with status: ${payout.status}`);
    }

    // Update to processing
    await db.update(payouts)
      .set({
        status: 'processing',
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(payouts.id, payoutId));

    // Process based on method
    let result;
    if (payout.payoutMethod === 'mpesa') {
      result = await this.processMpesaPayout(payout);
    } else {
      // Bank transfer would go here
      result = { success: false, error: 'Bank transfers not yet supported' };
    }

    if (result.success) {
      // Mark as completed
      const updatedResult = await db.update(payouts)
        .set({
          status: 'completed',
          gatewayReference: result.reference,
          gatewayResponse: JSON.stringify(result.response),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(payouts.id, payoutId))
        .returning();

      if (!updatedResult[0]) {
        throw new Error('Failed to update payout');
      }

      // TODO: Send notification to vendor
      return updatedResult[0];
    } else {
      // Mark as failed
      const retryCount = parseInt(payout.retryCount || '0') + 1;
      
      const failedResult = await db.update(payouts)
        .set({
          status: retryCount >= 3 ? 'failed' : 'pending',
          failureReason: result.error,
          gatewayResponse: JSON.stringify(result.response),
          retryCount: retryCount.toString(),
          updatedAt: new Date(),
        })
        .where(eq(payouts.id, payoutId))
        .returning();

      if (!failedResult[0]) {
        throw new Error('Failed to update payout');
      }

      throw new Error(`Payout failed: ${result.error}`);
    }
  }

  // Process scheduled payouts (cron job)
  async processScheduledPayouts() {
    const now = new Date();

    // Get all pending payouts that are due
    const duePayout = await db.query.payouts.findMany({
      where: and(
        eq(payouts.status, 'pending'),
        sql`${payouts.scheduledAt} <= ${now}`
      ),
      limit: 10, // Process 10 at a time
    });

    const results = [];

    for (const payout of duePayout) {
      try {
        const processed = await this.processPayout(payout.id);
        results.push({ payoutId: payout.id, success: true, data: processed });
      } catch (error: any) {
        results.push({ payoutId: payout.id, success: false, error: error.message });
      }
    }

    return results;
  }

  // Get vendor payouts
  async getVendorPayouts(vendorId: string, filters?: any) {
    const conditions = [eq(payouts.vendorId, vendorId)];

    if (filters?.status) {
      conditions.push(eq(payouts.status, filters.status));
    }

    const vendorPayouts = await db.query.payouts.findMany({
      where: and(...conditions),
      with: {
        booking: {
          columns: {
            id: true,
            startDate: true,
            endDate: true,
          },
        },
      },
      limit: filters?.limit || 20,
      offset: filters?.offset || 0,
      orderBy: (payouts, { desc }) => [desc(payouts.createdAt)],
    });

    return vendorPayouts;
  }

  // Get vendor earnings summary
  async getVendorEarnings(vendorId: string) {
    const earnings = await db.query.payouts.findMany({
      where: eq(payouts.vendorId, vendorId),
    });

    const summary = {
      totalEarnings: 0,
      completedPayouts: 0,
      pendingPayouts: 0,
      pendingAmount: 0,
    };

    earnings.forEach(payout => {
      if (payout.status === 'completed') {
        summary.totalEarnings += parseFloat(payout.netAmount);
        summary.completedPayouts++;
      } else if (payout.status === 'pending') {
        summary.pendingAmount += parseFloat(payout.netAmount);
        summary.pendingPayouts++;
      }
    });

    return summary;
  }

  // Admin: Get all payouts
  async getAllPayouts(filters?: any) {
    const conditions = [];

    if (filters?.status) {
      conditions.push(eq(payouts.status, filters.status));
    }

    const allPayouts = await db.query.payouts.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      with: {
        vendor: {
          columns: {
            id: true,
            businessName: true,
          },
        },
        booking: {
          columns: {
            id: true,
            startDate: true,
          },
        },
      },
      limit: filters?.limit || 50,
      offset: filters?.offset || 0,
      orderBy: (payouts, { desc }) => [desc(payouts.createdAt)],
    });

    return allPayouts;
  }

  // Admin: Manual payout trigger
  async triggerManualPayout(payoutId: string) {
    return this.processPayout(payoutId);
  }
}