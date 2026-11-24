// Run a batch where each item is independent (lifecycle ticks, sweepers). One bad row must
// not stop the rest, and must not make the whole job fail and retry forever: the error is
// logged with the item's identity and counted; the next scheduled run tries it again.
import { logger } from './logger.js';

export async function eachIsolated<T>(items: readonly T[], label: string, key: (item: T) => string, fn: (item: T) => Promise<void>): Promise<{ failed: number }> {
  let failed = 0;
  for (const item of items) {
    try {
      await fn(item);
    } catch (err) {
      failed++;
      logger.error({ step: label, item: key(item), err: (err as Error).message }, 'batch item failed; will be retried on the next run');
    }
  }
  return { failed };
}
