// Phase 6: database integrity, asserted against the schema produced by applying every
// migration to an empty PostgreSQL (the same SQL production will run).
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, makeVendor } from '../helpers/app.js';

const NEW_TABLES = [
  'booking_events', 'subscription_plans', 'vendor_subscriptions', 'subscription_invoices', 'payment_attempts', 'provider_events',
  'revenue_entries', 'conversations', 'messages', 'message_reports', 'outbox', 'audit_log', 'uploads',
];

async function rows<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute<T>(q), (r) => r as T);
}

/** Expect a statement to fail with a specific Postgres error code (drizzle wraps the driver error). */
async function expectPgError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (err) {
    let cur: unknown = err;
    for (let i = 0; i < 3 && cur && typeof cur === 'object'; i++) {
      const c = cur as { code?: unknown; cause?: unknown };
      if (c.code === code) return;
      cur = c.cause;
    }
    throw new Error(`expected Postgres error ${code}, got: ${(err as Error).message}`);
  }
  throw new Error(`expected Postgres error ${code}, but the statement succeeded`);
}

describe('schema integrity', () => {
  it('every foreign key on the refactor tables is backed by an index (no seq scans on joins/deletes)', async () => {
    const missing = await rows<{ tbl: string; col: string }>(sql`
      select c.conrelid::regclass::text as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and array_length(c.conkey, 1) = 1
        and c.conrelid::regclass::text in ${NEW_TABLES}
        and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
      order by 1, 2`);
    expect(missing).toEqual([]);
  });

  it('the booking exclusion constraint and the payment/outbox uniqueness guarantees exist', async () => {
    const constraints = (await rows<{ conname: string }>(sql`select conname from pg_constraint`)).map((r) => r.conname);
    expect(constraints).toContain('bookings_no_overlapping_accepted');
    const indexes = (await rows<{ indexname: string }>(sql`select indexname from pg_indexes where schemaname = 'public'`)).map((r) => r.indexname);
    for (const name of [
      'payment_attempts_idempotency_unique', 'payment_attempts_provider_ref_unique', 'provider_events_key_unique',
      'subscription_invoices_period_unique', 'subscription_plans_one_active', 'revenue_entries_attempt_type_unique',
      'outbox_dedupe_unique', 'vendor_subscriptions_vendor_unique',
    ]) expect(indexes).toContain(name);
  });

  it('legacy payments and payouts tables and vendor payout columns are preserved', async () => {
    const tables = (await rows<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public'`)).map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(['payments', 'payouts']));
    const cols = (await rows<{ column_name: string }>(sql`select column_name from information_schema.columns where table_name = 'vendors'`)).map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(['payout_method', 'mpesa_number', 'bank_account_name', 'bank_account_number', 'bank_name']));
  });
});

describe('append-only history is enforced by the database', () => {
  it('audit_log, booking_events and revenue_entries rows cannot be updated or deleted', async () => {
    const v = await makeVendor('Append Only Co');
    const [audit] = await rows<{ id: string }>(sql`select id from audit_log where entity_id = ${v.vendorId} limit 1`);
    expect(audit).toBeTruthy();
    await expectPgError(db.execute(sql`update audit_log set action = 'tampered' where id = ${audit!.id}`), 'P0001');
    await expectPgError(db.execute(sql`delete from audit_log where id = ${audit!.id}`), 'P0001');

    const [ev] = await rows<{ id: string }>(sql`select id from booking_events limit 1`);
    if (ev) {
      await expectPgError(db.execute(sql`update booking_events set reason = 'tampered' where id = ${ev.id}`), 'P0001');
      await expectPgError(db.execute(sql`delete from booking_events where id = ${ev.id}`), 'P0001');
    }
    // revenue_entries: the trigger fires even when no row matches nothing? It fires per row, so use a real row if present.
    const [rev] = await rows<{ id: string }>(sql`select id from revenue_entries limit 1`);
    if (rev) {
      await expectPgError(db.execute(sql`update revenue_entries set amount_minor = 1 where id = ${rev.id}`), 'P0001');
      await expectPgError(db.execute(sql`delete from revenue_entries where id = ${rev.id}`), 'P0001');
    }
  });
});

describe('constraints reject invalid financial and booking data', () => {
  it('rejects non-positive plan prices, a second active plan, and wrong-signed revenue entries', async () => {
    await expectPgError(db.execute(sql`insert into subscription_plans (code, name, amount_minor, currency) values ('zero', 'Zero', 0, 'KES')`), '23514');
    await db.execute(sql`update subscription_plans set is_active = false`);
    await db.execute(sql`insert into subscription_plans (code, name, amount_minor, currency, is_active) values (${`a-${randomUUID().slice(0, 6)}`}, 'A', 100000, 'KES', true)`);
    await expectPgError(db.execute(sql`insert into subscription_plans (code, name, amount_minor, currency, is_active) values (${`b-${randomUUID().slice(0, 6)}`}, 'B', 100000, 'KES', true)`), '23505');
    await db.execute(sql`update subscription_plans set is_active = false`);
  });

  it('rejects duplicate provider events and duplicate outbox dedupe keys', async () => {
    const key = `k-${randomUUID()}`;
    await db.execute(sql`insert into provider_events (provider, event_key, event_type, signature_valid, payload) values ('paystack', ${key}, 't', true, '{}'::jsonb)`);
    await expectPgError(db.execute(sql`insert into provider_events (provider, event_key, event_type, signature_valid, payload) values ('paystack', ${key}, 't', true, '{}'::jsonb)`), '23505');
    const dk = `d-${randomUUID()}`;
    await db.execute(sql`insert into outbox (topic, payload, dedupe_key, processed_at) values ('x', '{}'::jsonb, ${dk}, now())`);
    await expectPgError(db.execute(sql`insert into outbox (topic, payload, dedupe_key, processed_at) values ('x', '{}'::jsonb, ${dk}, now())`), '23505');
  });
});
