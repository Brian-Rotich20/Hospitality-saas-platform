import cron from 'node-cron';
import { PayoutService } from '../modules/payouts/payouts.service.js';

const payoutService = new PayoutService();

// Run every hour
export function startPayoutCron() {
  cron.schedule('0 * * * *', async () => {
    console.log('🕐 Running scheduled payout job...');
    
    try {
      const results = await payoutService.processScheduledPayouts();
      console.log(`✅ Processed ${results.length} payouts`);
    } catch (error) {
      console.error('❌ Payout cron failed:', error);
    }
  });

  console.log('✅ Payout cron job started');
}

// This automatically starts the cron job when this module is imported
// 