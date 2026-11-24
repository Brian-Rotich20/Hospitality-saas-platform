// Transactional outbox writer. Call inside the transaction that performs the state change,
// so a notification exists if and only if the change committed.
import { outbox } from '../../platform/database/schema/platform.js';
import type { Db } from '../../platform/database/client.js';

export type OutboxTopic =
  | 'booking.requested'
  | 'booking.accepted'
  | 'booking.declined'
  | 'booking.expired'
  | 'booking.cancelled'
  | 'message.created'
  | 'subscription.trial_reminder'
  | 'subscription.payment_due'
  | 'subscription.payment_succeeded'
  | 'subscription.payment_failed'
  | 'subscription.suspended'
  | 'subscription.expired';

export interface OutboxOptions {
  /** Unique key: a second enqueue with the same key is silently ignored. */
  dedupeKey?: string;
  availableAt?: Date;
}

export async function enqueueOutbox(tx: Db, topic: OutboxTopic, payload: Record<string, unknown>, opts: OutboxOptions = {}): Promise<boolean> {
  const rows = await tx.insert(outbox)
    .values({ topic, payload, dedupeKey: opts.dedupeKey ?? null, availableAt: opts.availableAt ?? new Date() })
    .onConflictDoNothing({ target: outbox.dedupeKey })
    .returning({ id: outbox.id });
  return rows.length > 0;
}
