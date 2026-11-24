# LinkMart backend: final implementation report (Option B, Phases 4–6)

Branch `refactor` (renamed from `refactor/option-b` outside this work; commit `40da6a3` present). Date: 2026-11-24.
All Phase 1–6 work is **uncommitted** in the working tree. Nothing deployed, no production connection, no production
migration, the baseline is not recorded anywhere, git history unchanged, no frontend files touched, no vendor records,
trial dates, payments or payout data altered.

Companion documents: [IMPLEMENTATION-REPORT.md](./IMPLEMENTATION-REPORT.md) (Phases 1–3),
[API-REFERENCE.md](../api/API-REFERENCE.md), [FRONTEND-INTEGRATION-GUIDE.md](../api/FRONTEND-INTEGRATION-GUIDE.md),
[openapi.json](../api/openapi.json), [RUNBOOK.md](../operations/RUNBOOK.md).

**Status labels used throughout**
- ✅ **Verified**: implemented and verified by automated tests against real PostgreSQL 17, Redis 7 and BullMQ.
- 🟡 **Not externally verified**: implemented and tested against controlled fakes, never run against the real provider.
- ⚙️ **Awaiting approval**: implemented and configurable, but switched off or defaulted pending a business decision.
- ⛔ **Not implemented (approval required)**: deliberately not built because it would commit the business to a policy.
- ➖ **Not applicable**: excluded by the business model (no booking payments, no payouts).

---

## 1. Executive summary

The backend is **functionally complete** for the approved model: request-to-book marketplace, instant vendor onboarding
with a one-month trial, admin-priced monthly subscriptions paid by card (Paystack) or M-Pesa STK Push, messaging,
reviews, and admin tooling. Phases 4–6 hardened subscription payments, background jobs and notifications, and closed
the security and integrity gaps found in a full review.

| Gate | Result |
| --- | --- |
| Tests | **130 passed / 130** (12 files: 21 unit, 109 integration), real Postgres + Redis + BullMQ. Was 67 after Phase 3 |
| TypeScript | 0 errors (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); no `any`, `@ts-ignore` or `@ts-expect-error` in `src/` |
| ESLint (type-checked) | 0 problems |
| Build | passes (`dist/server.js`, `dist/worker.js`, `dist/scripts/*`) |
| Migrations | 0000→0004 applied to an empty database on every test run; `drizzle-kit check` clean; no schema drift |
| `npm audit --omit=dev` | 0 critical, 0 high (4 moderate, dev-only drizzle-kit/esbuild chain) |
| `npm audit` (all) | 0 critical, **0 high** (was 1 high, fixed); 11 moderate, all dev-only tooling |

**It is not ready for production launch yet.** Payment providers have never been exercised against real sandboxes. The
production database is unidentified (D13). No subscription price exists. The four existing vendors need a transition
decision (D3). Phase 0 owner actions are outstanding (credential rotation, history purge). The cookie and domain
setup is undecided. See sections 17 and 20.

## 2. Phase 4: subscription payment hardening

Built on the Phase 2 architecture. The defects found and fixed:

| # | Defect found in review | Fix | Status |
| --- | --- | --- | --- |
| 1 | A provider reversal or refund of a credited payment was silently ignored (the "never downgrade a success" rule swallowed it) | `recordReversal`: negative `refund`/`reversal` journal entry (never more than the original amount, idempotent), attempt → `reversed` on full reversal, review flag, audit. Invoice and access are deliberately unchanged (no approved policy) | ✅ (🟡 provider payload shape) |
| 2 | A reversed payment could be re-credited by a later "success" report | `applyOutcome` treats `reversed` as terminal for crediting | ✅ |
| 3 | Amount or currency mismatch was recorded only as a failure string, with no review queue | Explicit `requires_review` + `review_reason` columns; audit | ✅ |
| 4 | Paystack verification did not check the returned reference | `reference_mismatch` → not credited, flagged | ✅ |
| 5 | Daraja: the amount reported in the callback was never compared | Callback `Amount` stored and checked against the expected amount before crediting (STK Query carries no amount) | ✅ |
| 6 | A callback arriving before the attempt was linked (initiation race) was marked processed and lost | Unmatched events are retried by reconciliation for 60 minutes, linked when the attempt appears, then parked as **unmatched** for admins | ✅ |
| 7 | Stored webhook payloads kept Paystack card authorization codes and signatures, and full M-Pesa phone numbers | `sanitizeProviderPayload` before storage | ✅ |
| 8 | Provider error text (which can describe configuration) reached vendors via `failureReason` and the 502 message | Stable code on the attempt, details only in logs, generic vendor message | ✅ |
| 9 | Reusing an `Idempotency-Key` with a different provider returned the wrong attempt | 409 `IDEMPOTENCY_KEY_REUSED` | ✅ |
| 10 | Reconciliation retried unverifiable attempts forever and one bad row aborted the run | Per-item isolation; close after 2× the provider's abandonment window (`unverifiable_timed_out`); a later provider success still credits | ✅ |
| 11 | Payment for an already-settled invoice was flagged only in the revenue journal | Also flagged on the attempt (`paid_settled_invoice`); the period is never extended twice | ✅ |
| 12 | No way for admins to investigate payments | `/api/admin/payments` (list or filter, review queue, detail with provider events, journal and audit; close a review with a note; re-verify with the provider), `/api/admin/subscriptions/vendors/:id` | ✅ |
| 13 | Admin vendor view exposed vendor payout details | Replaced by `hasPayoutDetails` | ✅ |
| 14 | No notification when a subscription expires | `subscription.expired` email (deduped) | ✅ |

Unchanged and re-verified: one-month trial, monthly invoices (unique per period), admin-configured price (none seeded),
billing hold with no plan, grace → suspended → expired, reminders, cancellation at period end, no automatic M-Pesa
deduction, saved-card renewal switched off (⚙️ D4), no automatic enrolment of the four existing vendors, no trial
dates changed.

**Refunds:** ⛔ No refund feature. LinkMart does not initiate refunds. Refunds made in the Paystack dashboard arrive as
`refund.processed` and are recorded and flagged. Booking payments cannot be affected because none exist: payment
tables have no booking reference (asserted by a test).

## 3. Phase 5: background jobs and operational workflows

| Area | Change | Status |
| --- | --- | --- |
| Outbox dispatcher | Rewritten. Previously it held one DB transaction (and row locks) open while sending emails, re-sent earlier emails when a later recipient failed, never dead-lettered, and marked unknown topics "processed". Now: short claim transaction with `SKIP LOCKED` and a 5-minute lease; send outside any transaction; `delivered_count` saved after each email; exponential backoff; dead-letter (`failed_at`) after 8 attempts or on a permanent error | ✅ |
| Duplicate prevention | Reminders deduped by key (verified across repeated scheduler runs); concurrent dispatchers deliver each row exactly once (tested with 4 in parallel) | ✅ |
| Lifecycle and sweepers | Each row runs in isolation (`eachIsolated`): one bad subscription or booking no longer aborts the tick or makes it retry forever. Errors are counted and logged with the row id | ✅ |
| Worker runtime | Extracted to `jobs/runtime.ts` (testable start/stop). Added the BullMQ `error` listener (without it an emitted error crashes the process), stalled-job and permanent-failure logging, completion logs with duration, and a liveness heartbeat. Idempotent graceful stop | ✅ |
| Redis on request paths | Expiry scheduling in the booking request was unbounded: with queue Redis down, a customer's booking request could hang. Now bounded to 2 s (`withQueueTimeout`); the sweeper and service-level deadline cover it | ✅ (unit-tested timeout; full queue-Redis outage not simulated) |
| Admin operations | `/api/admin/operations`: health (DB, Redis, queue counts, live workers, outbox backlog and dead letters, payment review counts), failed jobs list and retry, outbox list and retry, audit-log query. All admin-only and audited | ✅ |
| Booking workers | 24 h expiry via a delayed job executed by a **live worker** (tested end to end), sweeper, auto-completion: all idempotent. Availability holds: ➖ requests don't hold dates (D10). Booking payment jobs: ➖ |
| Subscription workers | Trial end, renewal, grace, suspension, expiry, cancellation, reminders, reconciliation: idempotent, re-check state under row locks, safe under duplicate execution | ✅ |
| Failed-payment retries | Vendors retry by starting a new payment (reminders on days 0/2/4/6). No automatic re-charge (M-Pesa can't; card auto-renew ⚙️ D4) | ✅ |
| Recovery | Delayed jobs and schedules persist in Redis; stalled jobs are re-run; outbox leases expire; procedures in the [runbook](../operations/RUNBOOK.md) | ✅ |

## 4. Phase 6: security, quality and production readiness

- Full review of authentication, guards, tenant isolation, data exposure, payments, uploads, input handling, logging and
  configuration (section 8). Every route has the narrowest guard; services re-check.
- Database integrity review against the migrated schema (section 9): found and fixed **11 unindexed foreign keys**; added
  **append-only triggers** for the audit log, booking events and revenue journal.
- Tests expanded from 67 to 130 (section 11), covering every Phase 6 test area.
- OpenAPI generated from the live schemas and committed, with a drift test. Human API reference and frontend guide written.
- Dependencies: removed 3 unused (`nanoid`, `@vitest/ui`, `prettier`; each confirmed unreferenced); fixed the one high
  advisory (`brace-expansion` via ESLint) with a non-breaking update.
- Baseline hardening headers (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`); extended log redaction.

## 5. Payment provider implementation and verification

| Capability | Paystack | Daraja (M-Pesa STK Push) |
| --- | --- | --- |
| Initiation | Hosted checkout (`/transaction/initialize`), reference `lm_<attempt>` | STK Push (password, EAT timestamp, ≤12-char account reference) |
| Authenticity | HMAC-SHA512 over the raw body, constant-time | Secret path token (constant-time) + optional IP allow-list |
| Verification before credit | `/transaction/verify`: status, exact amount, currency, **reference** | STK Query result + callback amount check |
| Idempotency | `Idempotency-Key`, in-flight reuse (3 min), unique provider reference, unique provider events | same |
| Pending / timeout | Reconciliation every 10 min; abandoned after 24 h | Reconciliation; abandoned after 60 min |
| Failed / cancelled | Recorded, vendor notified | `1032` → cancelled; other codes → failed |
| Delayed or early messages | Late success after a timeout is still credited; early callbacks retried and linked | same |
| Reversals | `refund.processed` recorded (negative journal entry, review); `reversed` status on verify recorded; disputes flagged | ⛔ No Safaricom notification exists for STK reversals; recording M-Pesa reversals manually needs approval (N5) |
| Recurring | ⚙️ Saved card (`charge_authorization`), off (D4) | ➖ None (each month is a vendor-approved STK request) |

**Sandbox verification: 🟡 not done.** No sandbox credentials were provided, and none were requested or used. Every
scenario in the brief is covered with controlled fakes through the real HTTP stack, and request shapes are
unit-tested with a fake `fetch`:

| Scenario | Paystack | Daraja |
| --- | --- | --- |
| Success | ✅ fake | ✅ fake |
| Failure | ✅ fake | ✅ fake (cancel) |
| Pending | ✅ fake | ✅ fake |
| Duplicate callbacks | ✅ fake | ✅ fake |
| Invalid signature / token | ✅ | ✅ |
| Amount mismatch | ✅ fake | ✅ fake |
| Currency mismatch | Shares the amount-mismatch code path; no dedicated test | ➖ KES only |
| Reference mismatch | ✅ fake | ➖ |
| Delayed / early callbacks | ✅ fake | ✅ fake |
| Repeated verification | ✅ fake | ✅ fake |
| Reversed transactions | ✅ fake (full, partial, repeated) | ⛔ |
| Paid twice | ✅ fake (card + M-Pesa for one invoice) | ✅ fake |

**Before enabling either provider:** run these scenarios against the Paystack test mode and the Daraja sandbox. Confirm
the `refund.processed` and dispute payload fields (`transaction_reference`, `transaction.reference`, `amount`) and the
STK Query responses for timeouts.

## 6. Subscription architecture

- **Ownership:** `subscriptions` owns lifecycle and entitlement decisions (`applyInvoicePaid`, `runLifecycle`,
  `getEntitlement`). `payments` owns provider interaction and verification and calls the subscription service only to
  apply a verified payment. Adapters are pure provider clients and never decide access.
- **States:** `trialing → past_due → active`; `active → past_due` each period; `past_due → suspended` after grace;
  `suspended → expired`; `cancelled`; any restricted state `→ active` on a verified payment. Entitled = trialing,
  active or past_due. No subscription row = `legacy_unenrolled` (entitled; D3).
- **Records:** `subscription_plans` (price history; one active), `vendor_subscriptions` (one per vendor),
  `subscription_invoices` (unique per period), `payment_attempts` (every attempt, with review fields),
  `provider_events` (every webhook/callback, unique, sanitised), `revenue_entries` (append-only journal; payments
  positive, refunds and reversals negative), `audit_log` (every transition).
- **Configurable:** grace days, expiry days, reminder schedules, reconcile interval (env). Price: admin-created plan only.

## 7. Background workers and operational workflows

Two processes from one image: API and worker (one or more). Schedules: request sweeper (5 min), auto-complete (60 min),
subscription tick (15 min), payment reconciliation (10 min), plus a delayed expiry job per booking request and the
continuous outbox loop. Admins manage: subscription status (view), pricing (plans), payment history and
investigation, vendor account suspension and reinstatement, audit records, failed jobs and failed notifications.
⛔ **Manual subscription reinstatement or complimentary access is not implemented**: it would grant unpaid access,
which is a business decision (N4). A vendor's subscription is restored by paying. **How operators find and recover
failed jobs:** [RUNBOOK.md](../operations/RUNBOOK.md).

## 8. Security audit findings

Fixed in this phase (all with regression tests):

| Severity | Finding | Fix |
| --- | --- | --- |
| High | Paystack card authorization codes and full phone numbers persisted in `provider_events` payloads | Sanitised before storage |
| High | Reversed or refunded payments could be silently ignored or re-credited | Section 2 |
| Medium | Customer booking requests could hang when queue Redis was unreachable (availability) | Bounded queue calls |
| Medium | Provider/config error text exposed to vendors | Generic message, details logged |
| Medium | Admin vendor endpoint returned vendor payout details (bank and M-Pesa numbers) | `hasPayoutDetails` only |
| Medium | Worker had no BullMQ `error` listener (process crash on connection errors) | Listener added |
| Low | 11 unindexed foreign keys (slow joins; deletes of referenced users would scan) | Migration 0004 |
| Low | Audit/journal tables mutable at the database level | Append-only triggers |
| Low | No baseline response hardening headers; redaction missed OTP and payout fields | Added |

Reviewed and confirmed (tested): sessions only from Better Auth cookies; banned users rejected; role cannot be set by
sign-up or profile update; dangerous Better Auth admin endpoints blocked; every admin endpoint 401/403 for others;
cross-vendor edits, publishes, deletes, blocks and booking reads return 404; drafts invisible to others; suspended
vendors can't create listings or book as customers, while billing and accepted bookings are unaffected; customer-only
booking; contact details only after acceptance; uploads type-checked from the bytes, re-encoded, deleted by owner or
admin only; webhook signature and token checks; Zod bounds on all input; search input bound as parameters (injection
attempts tested); 5xx and parse errors don't leak internals; secrets never logged. KYC documents: ➖ the KYC upload
endpoint was removed in Phase 0, and no KYC data is served.

Still open (owner actions, Phase 0): the leaked Render DB password must be rotated and the public git history purged;
`NODE_ENV=production` must be confirmed on deployed services.

## 9. Database schema and migration changes

| Migration | Content | Lock and production impact |
| --- | --- | --- |
| `0003_payments_review_and_outbox_delivery` | `payment_attempts`: `reversed_at`, `requires_review`, `review_reason`, `reviewed_at`, `reviewed_by` (FK users), `review_note`; review and FK indexes. `outbox`: `delivered_count`, `failed_at`; pending index narrowed, failed index. `provider_events`: unmatched and attempt indexes. Idempotent backfills of review flags and dead letters. Append-only triggers on `audit_log`, `booking_events`, `revenue_entries` | Additive. Constant-default columns don't rewrite tables (PG 11+). Tables are created by 0001, so they're empty in production when this runs |
| `0004_foreign_key_indexes` | 11 indexes: booking events actor, message sender and hidden-by, report reporter and resolver, revenue vendor and invoice, invoice plan, subscription plan, plan creator, attempt reviewer | Additive; tables new and empty at release |

- **Nothing dropped.** `payments`, `payouts`, vendor payout columns, booking fee columns and legacy `status` are preserved
  (asserted by a test). No data rewritten except the idempotent backfills above (no-ops on a fresh release).
- **Verified on disposable databases:** every test run applies 0000→0004 to empty PostgreSQL 17. `drizzle-kit check`
  is clean and `generate` reports no changes. Migration files are LF (hashes depend on the bytes): 0003
  `baaad259…c904`, 0004 `958e2015…8ae4`; the baseline is unchanged (`8b14d6bb…7d2e`).
- **Production release (not executed):** record the baseline as applied, then run 0001–0004 together in one
  maintenance window (0002's exclusion-constraint build briefly locks `bookings`). This needs `CREATE EXTENSION btree_gist`
  and `CREATE FUNCTION/TRIGGER` privileges. Rollback: restore the pre-release backup. Running the old code against the migrated
  schema has not been tested, so don't rely on it.

## 10. API and OpenAPI documentation

- `docs/api/openapi.json`: 86 paths, generated from the actual Zod route schemas (`npm run openapi:export`). Every
  operation is tagged; the session-cookie scheme is declared. `test/integration/openapi.test.ts` fails if the committed
  file drifts from the routes, or if a booking-payment or payout endpoint appears.
- **Limitation:** request schemas are complete; **response schemas are not declared** in the route definitions, so they
  are documented by hand in `API-REFERENCE.md` (envelope, booking view, payment attempt, subscription overview).
- `API-REFERENCE.md`: every endpoint with guard, request schema, notable responses and error codes, pagination, rate limits.
- `FRONTEND-INTEGRATION-GUIDE.md`: the 13 workflows and the breaking-change table.

## 11. Automated test results

Final run: **12 files, 130 tests, all passed**, 229 s (Windows 11, Docker; Testcontainers postgres:17-alpine and
redis:7-alpine). No `.skip` or `.only`; no test was weakened to pass.

| File | Tests | Covers |
| --- | --- | --- |
| unit/time-and-templates | 7 | month-end clamping, Nairobi dates, template escaping |
| unit/payment-adapters | 10 | Paystack HMAC, request shapes; Daraja password, timestamp, MSISDN, query states |
| unit/operations-helpers (new) | 4 | batch isolation, queue timeout, payload sanitising, reference extraction |
| integration/auth-roles | 10 | sessions, OTP, role restrictions, customer-only booking |
| integration/bookings | 18 | lifecycle, 24 h expiry (service, job, sweeper), conflicts, concurrent accept, exclusion constraint, completion, isolation |
| integration/messaging | 5 | access, limits, reporting, moderation, read-only |
| integration/subscriptions | 17 | trial, plans, billing, grace, suspension, expiry, cancellation, Paystack and M-Pesa flows, legacy vendors, revenue |
| integration/payments-hardening (new) | 21 | refunds and reversals (full, partial, repeated), no re-credit, disputes, reference/amount mismatch, paid twice, idempotency reuse, generic provider errors, payload sanitising, early/unmatched callbacks, unverifiable attempts, reconciliation idempotency, admin investigation, private card/payout data |
| integration/operations (new) | 15 | outbox partial delivery, dead letters and admin retry, max attempts, concurrent dispatch, transaction rollback, reminder dedupe, **live BullMQ worker** (delayed expiry, retries, failed set, admin retry), graceful shutdown, Redis cache outage, admin-only, audit query |
| integration/security (new) | 15 | admin endpoint matrix, role tampering, banned sessions, cross-vendor isolation, suspended vendors, subscription-independent acceptance, uploads, error leakage, SQL injection, validation bounds, headers |
| integration/database-integrity (new) | 6 | FK indexes, key constraints, legacy data preserved, append-only triggers, plan/provider-event/outbox constraints |
| integration/openapi (new) | 2 | document completeness and drift |

Not covered automatically: real provider sandboxes (🟡); a full outage of the *queue* Redis connection (the request-path
timeout is unit-tested; the cache outage is integration-tested); multi-instance worker failover (covered by BullMQ
semantics plus concurrent-dispatch and idempotency tests, not by killing processes).

## 12. TypeScript, ESLint and build results

`npm run typecheck`: 0 errors. `npm run lint`: 0 problems (type-checked rules, `no-explicit-any`, floating promises).
`npm run build`: passes. No `any`, `@ts-ignore` or `@ts-expect-error` in `src/`. Test-only type assertions are
confined to `test/`. No circular module dependencies were introduced: new modules depend only on `platform/` and on
other modules' services.

## 13. Dependency audit results

| Audit | Critical | High | Moderate | Notes |
| --- | --- | --- | --- | --- |
| `npm audit --omit=dev` | 0 | 0 | 4 | drizzle-kit → @esbuild-kit/esbuild chain (CLI tooling, not in the runtime image path) |
| `npm audit` | 0 | 0 | 11 | the above + testcontainers → archiver/zip-stream/glob (test tooling). The fixes need breaking major upgrades (`--force`), so they're not applied |

Changes: removed `nanoid`, `@vitest/ui`, `prettier` (no references anywhere); `npm audit fix` (non-breaking) updated
`brace-expansion` under ESLint (cleared the only high).

## 14. Modified and newly created files (Phases 4–6, under `backend/` unless noted)

**New**
- `src/modules/operations/service.ts`, `src/modules/operations/routes.ts`
- `src/jobs/runtime.ts`, `src/platform/batch.ts`, `src/scripts/export-openapi.ts`
- `src/platform/database/migrations/0003_payments_review_and_outbox_delivery.sql`, `0004_foreign_key_indexes.sql`, `meta/0003_snapshot.json`, `meta/0004_snapshot.json`
- `test/integration/{payments-hardening,operations,security,database-integrity,openapi}.test.ts`, `test/unit/operations-helpers.test.ts`
- `docs/api/{openapi.json,API-REFERENCE.md,FRONTEND-INTEGRATION-GUIDE.md}`, `docs/operations/RUNBOOK.md`, this report

**Modified**
- `src/modules/payments/service.ts` (hardening, admin functions), `src/modules/payments/routes.ts` (admin routes, tags)
- `src/modules/subscriptions/service.ts` (admin detail, expiry notification, isolated lifecycle), `src/modules/subscriptions/routes.ts`
- `src/modules/notifications/dispatcher.ts` (rewrite), `src/modules/notifications/outbox.ts`
- `src/modules/bookings/service.ts` (isolated sweepers), `src/modules/vendors/service.ts` (admin view), `src/modules/identity/routes.ts` (tag)
- `src/platform/queue/index.ts`, `src/platform/mailer/templates.ts`, `src/platform/logger.ts`
- `src/platform/database/schema/{subscriptions,platform,messaging,bookings}.ts`, `src/platform/database/migrations/meta/_journal.json`
- `src/app/build-app.ts`, `src/worker.ts`
- `test/helpers/{app,fake-providers}.ts`, `test/setup/global-setup.ts`
- `package.json`, `package-lock.json`, `.env.example` (comment only), `/CLAUDE.md` (repo root)

## 15. Known limitations

1. 🟡 Paystack and Daraja have never run against real sandboxes. The refund and dispute payload field names follow the documentation.
2. Only one refund and one reversal journal row per payment. A second partial refund is flagged (`additional_reversal_not_journaled`) for manual reconciliation.
3. Reversals and disputes never change access automatically (N3). M-Pesa reversals can't be recorded in the system (N5).
4. Email is at-least-once. A crash between Brevo accepting a message and `delivered_count` being saved can duplicate that one email.
5. Email only: no in-app notifications or push, and messaging is polling (no websockets).
6. Cross-site cookies (`SameSite=None`) are not configured. The frontend and API must be same-site, or this must be added (N6).
7. OpenAPI has no response schemas (documented by hand).
8. No metrics or alerting integration. Observability is structured logs plus the admin health endpoint.
9. No admin "grant access" or manual subscription reinstatement (N4).
10. Legacy `payments`/`payouts` tables and vendor payout columns remain, unused (D9; removal is a separate contract migration).
11. Everything is uncommitted. On Windows, run Vitest from a `D:\` path, not Git Bash `/d/`. Untracked local scripts remain (`src/db/clear.ts` truncates all tables; consider deleting it).

## 16. Unresolved decisions (D1–D12 from the Phase 1–3 register, plus later items)

The original questions are taken from the Phase 1–3 register. "Blocks" = implementation or launch depends on the answer.

| ID | Original question | Current implementation / default | Recommendation | Blocks? | If you choose differently |
| --- | --- | --- | --- | --- | --- |
| **D3** | Transition policy for the 4 existing vendors | Not enrolled, unchanged, treated as entitled (`legacy_unenrolled`). Admin can enrol one at a time (trial from enrolment) | Enrol all four on launch day with a fresh one-month trial, announced by email in advance | **Yes**: billing them is a financial commitment | Trial from original onboarding date: they could be billed immediately. Leave unenrolled: they never pay |
| **D13** | Which database is production (Neon or Render)? | Unverified. Local and test work is unaffected | Confirm in writing; rotate the leaked Render password either way | **Yes** for any production migration | Running against the wrong DB, or the extension or trigger privileges being missing, would fail the release |
| D2a | Grace period | 7 days (`SUBSCRIPTION_GRACE_DAYS`) | Keep 7 | No (configurable) | Shorter: more suspensions. Longer: more unpaid access |
| D2b | Reminder timing | Trial: 7/3/1 days before; payment: days 0/2/4/6 after due; expire 30 days after suspension | Keep | No (configurable) | Each change is an env value |
| D1 | Restrictions when unpaid | Listings hidden, no publishing, no accepting. Allowed: drafts, billing, declining, existing accepted bookings, messaging | Keep (customers with accepted bookings are never harmed) | No | Blocking messaging or accepted bookings would hurt customers |
| D11 | Booking completion | Automatic 2 days after the end date (`BOOKING_AUTO_COMPLETE_DAYS`) | Keep; optionally add "mark complete" later | No (configurable) | 0 days enables reviews sooner; longer delays them |
| N1 | Email verification required to book and to become a vendor | Required | Keep (abuse control) | No | Removing it allows unverifiable accounts to send requests |
| N2 | Subscription prices in whole shillings | Enforced (M-Pesa can't charge cents) | Keep | No | Cents would make M-Pesa unusable for that price |
| **D4** | Paystack saved-card renewal | Built, **off** (`PAYSTACK_RECURRING_ENABLED=false`), opt-in only, verified before credit | Keep off at launch; enable after sandbox tests and consent wording | **Yes** to enable | Enabling charges cards automatically |
| D9 | Future of existing vendor payout details | Kept, owner-only; admins see `hasPayoutDetails` only; still collectable | Hide the screen now; later export and drop via a reviewed contract migration (or repurpose as "payment instructions" shown to accepted customers) | Yes for any deletion | Dropping deletes vendor data irreversibly |
| D5 | Price changes | Apply to invoices issued after activation | Keep | No | Mid-period changes would need proration |
| D6 | Currency | KES only | Keep | No | Others need provider and plan support |
| D7 | Cancellation and refunds | Cancel at period end; no refunds | Write a "no partial-month refunds" policy | Yes for any refund feature | |
| D8 | Booking price snapshot | Pricing type and currency only, no amounts | Keep (no booking money) | No | |
| D10 | Do requests block dates? | No; acceptance does; overlaps auto-declined | Keep | No | Blocking lets one customer lock a listing |
| D12 | Messaging scope | Text-only polling; 30 days after completion; report and hide | Keep for launch | No | |
| N3 | (new) What happens to access when a subscription payment is reversed, refunded or disputed? | Recorded and flagged; access and invoice unchanged; admin reviews | Decide a policy (e.g. reopen the invoice and apply normal grace) | Yes to automate | Automation without a policy could suspend vendors wrongly |
| N4 | (new) May admins grant or restore subscription access without payment? | Not implemented | Only if the business wants comps | Yes | |
| N5 | (new) Recording M-Pesa reversals (no provider notification) | Not implemented | Admin "record external reversal" bookkeeping endpoint, if wanted | Yes | |
| N6 | (new) Frontend and API domains (cookie SameSite) | Same-site assumed | Serve the API on a subdomain of the frontend domain | Yes before launch | Cross-site requires `SameSite=None; Secure` config |

## 17. Production deployment requirements

1. **Owner actions (Phase 0):** rotate the Render DB password; purge the leaked secret from the public git history
   (needs approval: a history rewrite); confirm the production DB (D13); confirm `NODE_ENV=production` per service.
2. **Commit and review** the Phase 1–6 working tree (it's large; review per module).
3. **Database release** (approval required; not done): back up; record the baseline as applied (Phase 0 SQL); run
   `node dist/scripts/migrate.js` (0001–0004) in a maintenance window. Verify `bookings_no_overlapping_accepted`, the
   three append-only triggers and `btree_gist`. Rehearse on a restored copy first.
4. **Services:** API and at least one worker from the same image; persistent Redis (`noeviction`), a separate
   `QUEUE_PREFIX` per environment; health checks on `/health`, readiness on `/ready`.
5. **Secrets:** section 18. No real values in the repo.
6. **Email:** Brevo with a verified sender; frontend serves the email link paths (guide, section 12).
7. **Domains and cookies:** same-site frontend and API (N6); `CORS_ORIGINS` and `BETTER_AUTH_URL` set; HTTPS only;
   `TRUST_PROXY=true` only behind your own proxy; `SWAGGER_ENABLED=false`.
8. **Payments, after sandbox verification:** Paystack webhook `{API_PUBLIC_URL}/api/payments/paystack/webhook`; Daraja
   callback `{API_PUBLIC_URL}/api/payments/daraja/callback/{DARAJA_CALLBACK_TOKEN}`; then set `*_ENABLED=true`.
9. **Business setup:** create and activate the plan once the price is decided (until then billing is held); enrol the
   legacy vendors per D3.
10. **CI:** `npm ci`, `npm run lint`, `npm run typecheck`, `npm test` (Docker), `npm run build`, `npm audit --omit=dev`.

## 18. Environment variables required

No new variables were added in Phases 4–6. Full annotated list: `backend/.env.example`.

| Group | Required in production | Optional / defaults |
| --- | --- | --- |
| App | `NODE_ENV`, `API_PUBLIC_URL`, `FRONTEND_URL`, `CORS_ORIGINS`, `COOKIE_SECRET` (≥32) | `PORT`, `HOST`, `LOG_LEVEL`, `SWAGGER_ENABLED=false`, `RATE_LIMIT_ENABLED=true`, `TRUST_PROXY=false` |
| Database | `DATABASE_URL` | `DATABASE_POOL_MAX=10`, `DATABASE_STATEMENT_TIMEOUT_MS=15000` |
| Redis | `REDIS_URL` | `CACHE_TIMEOUT_MS=250`, `QUEUE_PREFIX=linkmart` |
| Auth | `BETTER_AUTH_SECRET` (≥32), `BETTER_AUTH_URL` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Storage | Cloudinary trio, or the AWS S3 set | `STORAGE_PROVIDER=cloudinary`, `MAX_FILE_SIZE`, `ALLOWED_IMAGE_TYPES` |
| Email | `MAIL_TRANSPORT=brevo`, `BREVO_API_KEY`, `MAIL_FROM_EMAIL` | `MAIL_FROM_NAME` |
| Bookings | – | `BOOKING_RESPONSE_HOURS=24`, `BOOKING_MAX_OPEN_REQUESTS_PER_CUSTOMER=5`, `BOOKING_AUTO_COMPLETE_DAYS=2`, `MESSAGING_OPEN_DAYS_AFTER_COMPLETION=30` |
| Subscriptions | – (price is in the DB) | `SUBSCRIPTION_GRACE_DAYS=7`, `SUBSCRIPTION_EXPIRE_AFTER_SUSPENDED_DAYS=30`, `SUBSCRIPTION_TRIAL_REMINDER_DAYS=7,3,1`, `SUBSCRIPTION_PAYMENT_REMINDER_DAYS=0,2,4,6`, `PAYMENT_PENDING_RECONCILE_MINUTES=10` |
| Paystack (when enabled) | `PAYSTACK_ENABLED=true`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_CALLBACK_URL` | `PAYSTACK_BASE_URL`, `PAYSTACK_RECURRING_ENABLED=false` (D4) |
| Daraja (when enabled) | `DARAJA_ENABLED=true`, `DARAJA_ENVIRONMENT=production`, `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_SHORTCODE`, `DARAJA_PASSKEY`, `DARAJA_CALLBACK_TOKEN` (≥24) | `DARAJA_TRANSACTION_TYPE`, `DARAJA_PARTY_B`, `DARAJA_ALLOWED_IPS` |

## 19. Frontend integration requirements

See [FRONTEND-INTEGRATION-GUIDE.md](../api/FRONTEND-INTEGRATION-GUIDE.md). The essentials:
- Use `credentials: 'include'`; same-site deployment (N6); handle `401`/`403` codes and `EMAIL_NOT_VERIFIED`.
- Booking UI has **no payment step**. New statuses and `respondBy` countdowns. Contacts appear after acceptance.
- Vendor billing page at `/vendor/subscription`. Payment flows poll `GET /api/subscriptions/me/payments/:id`; never
  trust redirects. Send an `Idempotency-Key`. Hide card auto-renew and payout-details screens for now.
- Messaging by polling `?after=`; read-only on `CONVERSATION_CLOSED`.
- Breaking changes are listed at the end of the guide (statuses, 422 validation, removed payouts and dev and document endpoints, `spent`).

## 20. Final production-readiness assessment

| Area | Assessment |
| --- | --- |
| Marketplace core (catalog, request-to-book, availability, messaging, reviews) | ✅ Ready once deployed. Strong invariants (exclusion constraint, row locks, append-only history); well tested |
| Vendor onboarding and trial | ✅ Ready |
| Subscription lifecycle | ✅ Logic ready. ⚙️ No price configured (billing held until one is) |
| Subscription payments (Paystack, M-Pesa) | 🟡 **Not ready**: sandbox verification required before enabling. Safe while disabled |
| Background jobs and notifications | ✅ Ready (needs a running worker and persistent Redis) |
| Security | ✅ No known open application vulnerabilities. ⚠️ Phase 0 secret rotation and history purge outstanding |
| Data and migrations | ✅ Verified on disposable DBs. ⚠️ Production DB unidentified (D13); release not rehearsed on a production copy |
| Operations | ✅ Health, failed-job and dead-letter tooling, runbook. ⚠️ No external monitoring or alerting yet |
| Frontend | ⛔ Not started (out of scope). Backend contract documented |

**Verdict:** the backend is complete and well verified for its scope, but **not yet production-ready** in the
operational sense. Before going live: resolve D13 and D3, rotate credentials and purge history (owner), commit and
review the work, rehearse the migration on a production copy, run both payment providers against their sandboxes, decide
domains and cookies (N6), configure secrets, create the subscription plan, and add monitoring. Until the providers are
verified, the platform can launch with payments disabled: vendors stay entitled while billing is held.
