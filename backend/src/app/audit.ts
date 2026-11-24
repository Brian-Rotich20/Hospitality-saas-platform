import { auditLog } from '../platform/database/schema/platform.js';
import { db, type Db } from '../platform/database/client.js';

export interface AuditEntry {
  actorUserId?: string | null;
  actorType: 'user' | 'admin' | 'system' | 'provider';
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
  requestId?: string | undefined;
}

/** Append an audit record, normally inside the transaction that made the change. */
export async function recordAudit(entry: AuditEntry, tx: Db = db): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: entry.actorUserId ?? null,
    actorType: entry.actorType,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    details: entry.details ?? null,
    requestId: entry.requestId ?? null,
  });
}
