# LinkMart backend: revised Option B plan

Supersedes the financial sections of the original audit. Business rule: **LinkMart connects customers and vendors; customers pay vendors directly, outside the platform. LinkMart's only revenue and only payment processing is vendor subscriptions** (Paystack and Safaricom Daraja).

## 1. Impact of the business-model correction

### Removed (no booking money flows through LinkMart)

| Item | Location | Data at risk | Plan |
| --- | --- | --- | --- |
| Booking payments (Flutterwave) | `src/modules/payments/*` (never mounted) | `payments`: 0 rows (Neon) | Delete code in Phase 1. Drop table in a reviewed contract migration (Phase 5). |
| Vendor payouts | `src/modules/payouts/*` (mounted at `/api/payouts`, `/api/admin/payouts`), `src/jobs/payout.cron.ts` | `payouts`: 0 rows | Unmount and delete code in Phase 1. Drop table in Phase 5. |
| Booking fees and VAT | `bookings.service.ts` `calculatePricing`; columns `base_amount`, `platform_fee`, `vat`, `total_amount` | 0 bookings | Stop computing in Phase 3; columns made nullable then dropped (expand/contract). |
| `completeBooking` → payout trigger | `bookings.service.ts:249` | none | Replaced by a non-financial completion job (Phase 3). |
| Payment and payout emails, SMS | `notifications/email.service.ts`, `sms.service.ts`, `notifications.service.ts` | none | Delete in Phase 1. |
| Enums `payment_method`, `payment_status`, `payout_status` | schema | none | Dropped with their tables (Phase 5). |
| Booking status `confirmed`, `disputed` | `booking_status` enum | 0 bookings | Replaced by the new lifecycle (Phase 3). |

### Preserved

Better Auth identity data and sessions; users, vendors, listings, categories, availability, reviews and saved listings, with all their rows; listing publish rules; review rules (one per booking, vendor reply once, admin visibility); category tree; Kenyan phone validation; vendor ownership checks.

### No double-entry ledger

Without booking settlement there are no held funds, payables or payouts, so a double-entry ledger is unnecessary. Subscription accounting uses **append-only invoices, payment attempts and provider events**, plus an **immutable revenue journal** with reversal entries for refunds or reversals. That is auditable, reconcilable with providers, and nothing is ever updated in place or deleted.

## 2. Target domain model (new tables)

| Table | Purpose |
| --- | --- |
| `subscription_plans` | Admin-configured price (`amount_minor` bigint, `currency`), interval `month`, active flag; price changes create a new row (history kept) |
| `vendor_subscriptions` | One per vendor: `status` (trialing, active, past_due, suspended, cancelled, expired), `trial_started_at`, `trial_ends_at`, `current_period_start/end`, `grace_ends_at`, `cancel_at_period_end`, `plan_id` |
| `subscription_invoices` | One per billing period: amount snapshot, due date, status (open, paid, void, uncollectible), unique `(subscription_id, period_start)` |
| `payment_attempts` | Each Paystack initialize or Daraja STK request: provider, provider reference (unique), amount, status (initiated, pending, succeeded, failed, reversed), `idempotency_key` unique |
| `provider_events` | Every inbound webhook or callback, stored raw: provider, event id (unique per provider), signature-verified flag, processed_at; idempotency boundary |
| `revenue_entries` | Append-only journal: invoice paid (+), refund or reversal (−); never updated |
| `booking_events` | Audit trail of booking state transitions (who, from, to, reason, at) |
| `conversations`, `messages` | Booking-scoped customer–vendor messaging (opens on acceptance) |
| `uploads` | Owner-tracked files (owner, purpose, provider public id) |
| `outbox` | Transactional outbox for notifications and jobs |
| `audit_log` | Admin and security-relevant actions |

## 3. Booking lifecycle (no payment states)

```
requested ──accept──▶ accepted ──(end date + N days, job)──▶ completed
    │                    │
    ├─decline──▶ declined │
    ├─24h no response──▶ expired
    └─customer cancel──▶ cancelled ◀──customer or vendor cancel──┘
```

- `requested` carries a DB-backed `respond_by = created_at + 24h`. Accepting checks `now() < respond_by` in the same transaction (service-level enforcement). The BullMQ delayed job performs the transition idempotently: `UPDATE … WHERE status='requested' AND respond_by <= now()`.
- Accepted bookings are mutually exclusive per listing through a Postgres `EXCLUDE USING gist (listing_id WITH =, period WITH &&) WHERE (status = 'accepted')` constraint, so concurrent acceptances can't overlap.
- No post-acceptance payment hold exists, because there is no platform payment.
- Only users with role `customer` can create requests: enforced in the policy layer and re-checked in the service.

## 4. Subscriptions

- Trial starts when self-service onboarding creates the vendor: `trial_ends_at = +1 month` (calendar month).
- Renewal: at period end an invoice is created (idempotent on `(subscription, period_start)`). Payment is **requested**, never pulled without authorization:
  - Paystack: hosted checkout link (initialize transaction), verified server-side via the verify API and the `x-paystack-signature` HMAC-SHA512 webhook. Optional saved-card renewal (`charge_authorization`) only for vendors who opted in and whose authorization is `reusable`. Capability flag `PAYSTACK_RECURRING_ENABLED`.
  - Daraja: STK Push request to the vendor's number each cycle; callback correlated by `CheckoutRequestID`, confirmed with the STK Query API. Capability flags per product (STK, transaction status, reversal).
- Webhooks and callbacks: raw body stored, signature or source verified, de-duplicated by provider event id; the business effect (invoice paid, subscription active) is applied once in a transaction.
- Reconciliation job: daily, re-queries providers for attempts left `pending` beyond a threshold and for the previous day's succeeded attempts; mismatches go to an admin report.
- Vendor status (admin `approved` / `suspended`) and subscription status are separate. Effective vendor capability = vendor approved **and** subscription in an entitled state (see decision D1).

## 5. Phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| 0 | Safety and baseline. **Done**, see `PHASE-0-REPORT.md` | Typecheck, build and smoke tests pass; baseline matches DB |
| 1 | Foundations: `app/` and `platform/` (config, logger, db + tx helper, Redis-tolerant cache, BullMQ queue, mailer), `AppError` + global handler, typed request context, policy module, Zod schemas on every route, ESLint, `.env.example`, graceful shutdown, Vitest + Testcontainers harness, outbox + audit tables, uploads ownership, removal of payments/payouts code, dependency upgrades | Lint + typecheck + tests in CI; cross-tenant tests for all vendor resources |
| 2 | Vendors and subscriptions (state machine, trial, plans, admin price config, restrictions, notifications) | Integration tests: trial creation, trial expiry, renewal invoice, failed payment → past_due → suspended, restrictions |
| 3 | Bookings, availability, messaging (lifecycle, 24-hour deadline, exclusion constraint, expiry job, completion job, conversations) | Concurrency test, expiry tests, role tests, messaging access tests |
| 4 | Payment providers for subscriptions (Paystack + Daraja adapters, provider events, idempotency, reconciliation, revenue journal, refunds or reversals) | Recorded-payload webhook tests, duplicate-delivery tests, forged-signature rejection, reconciliation tests |
| 5 | Operations: BullMQ workers, retries, admin financial controls and reports; reviewed contract migration dropping `payments`, `payouts` and booking fee columns (with approval) | Worker idempotency tests; contract migration reviewed |
| 6 | Hardening: full test pass, security re-check, performance, deployment config (api + worker), docs | Readiness review |

## 6. Decisions required before Phases 2–3

Each has a proposed default. Approve or change them.

| # | Decision | Proposed default |
| --- | --- | --- |
| D1 | What a lapsed subscription restricts | `past_due` (inside grace): no restriction. `suspended` / `expired`: listings hidden from search and booking, can't publish or create listings, can't accept new requests. Still allowed: existing accepted bookings, messaging, profile, billing |
| D2 | Grace period and retry schedule | 7-day grace after due date; payment requests (email + STK/checkout link) on day 0, 2, 4, 6; `suspended` after grace; `expired` after 30 more days unpaid; reminders 7, 3 and 1 days before trial end and before each due date. All configurable |
| D3 | Trial for the 4 existing vendors | Trial starts at deployment of Phase 2 (not their original sign-up date) |
| D4 | Paystack renewal mode | Monthly invoice paid via checkout link by default; opt-in saved-card auto-renewal only with a reusable authorization |
| D5 | Price changes | Apply from each subscriber's next billing period; never mid-period |
| D6 | Currency | KES only for now (schema supports others) |
| D7 | Cancellation | Vendor-initiated cancel takes effect at period end (`cancelled`), no pro-rata refunds; refunds are admin-initiated only |
| D8 | Booking price data | Keep a non-binding `quoted_price_minor` + `currency` snapshot from the listing for reference; drop fee/VAT columns |
| D9 | Vendor payout details (M-Pesa, bank) | Repurpose as optional free-text **payment instructions** shown only to the customer of an *accepted* booking; drop bank-account columns later (contract migration) |
| D10 | Do `requested` bookings block dates? | No. Only `accepted` blocks. Accepting auto-declines overlapping open requests with reason "dates no longer available". A customer may hold at most 5 open requests |
| D11 | Completion | Auto-`completed` 2 days after end date unless cancelled; enables reviews. No platform money involved |
| D12 | Messaging scope | REST + polling (no websockets) in v1; text only, 2,000 chars; opens on acceptance, read-only 30 days after completion or cancellation; per-user rate limit; report-message + admin hide; throttled email notification for new messages |
| D13 | Which database is production | Owner to confirm: Neon (in `.env`) or Render (leaked credentials) |
