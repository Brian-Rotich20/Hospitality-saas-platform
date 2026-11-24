# LinkMart backend: Option B implementation report (Phases 1–3)

Branch `refactor/option-b`, uncommitted. Nothing deployed, no production migration run, the baseline not recorded anywhere, no git history rewritten, no production data touched, no frontend changes.
Date: 2026-11-24.

**Business model enforced throughout:** LinkMart connects customers and vendors. Customers pay vendors directly, outside the platform. LinkMart processes **only** vendor subscription payments (Paystack, M-Pesa STK Push).

---

## 1. Phase 1: foundations (complete)

| Deliverable | Where | Notes |
| --- | --- | --- |
| Modular structure | `src/app`, `src/platform`, `src/modules/*`, `src/jobs`, `src/server.ts`, `src/worker.ts` | 12 modules: identity, users, vendors, subscriptions, payments, catalog, availability, bookings, messaging, reviews, uploads, notifications |
| Central configuration | `platform/config/env.ts` | Single Zod schema; nothing else reads `process.env`. Fails fast listing variable *names*, never values. `NODE_ENV` required. Provider settings validated only when the provider is enabled |
| Typed request context + central authorization | `app/policies.ts` | `request.auth` / `request.vendorCtx`; guard sets `user`, `verifiedUser`, `customer`, `vendor`, `activeVendor`, `entitledVendor`, `admin`, run as `preValidation` (401 before validation). Services re-check critical rules |
| Error handling | `app/errors.ts`, `app/error-handler.ts` | Typed `AppError` hierarchy; one handler; Postgres errors mapped (23505→409, 23P01→409, 23503→422, 22P02→400, 57014→503); 5xx never leak internals; every response carries `requestId` |
| Validation | every route | Zod schemas for params, query and body on every route; no `request.body as any` remains |
| Transactions | `platform/database/client.ts` | `withTransaction`, `Db` type accepted by repositories; row locks (`FOR UPDATE`) on all state transitions |
| Logging | `platform/logger.ts` | pino JSON, request ids (`x-request-id` accepted and echoed), redaction of auth headers, cookies, signatures, tokens; `console.*` removed from app code |
| Redis resilience | `platform/cache/redis.ts` | Cache ops time out (250 ms) and degrade to misses; namespace versioning for invalidation; separate BullMQ connection; `/ready` reports Redis as non-fatal |
| Queue | `platform/queue/index.ts`, `src/worker.ts`, `src/jobs/processors.ts` | BullMQ; idempotent processors; job schedulers upserted on worker start |
| Outbox | `outbox` table, `modules/notifications` | Written inside the state-changing transaction; dedupe keys; dispatcher claims with `FOR UPDATE SKIP LOCKED`, exponential backoff |
| Audit log | `audit_log` table, `app/audit.ts` | Admin actions, subscription/payment transitions, vendor moderation |
| Rate limiting | `@fastify/rate-limit` (Redis store) | Global 300/min; tighter limits on auth (30), OTP (10/3), bookings (10), payments (5), messages (20), uploads |
| Graceful shutdown | `server.ts`, `worker.ts` | SIGTERM: stop accepting, drain, close queues, DB pool and Redis; forced exit after timeout |
| Health | `/health` (liveness), `/ready` (DB + Redis) | Docker `HEALTHCHECK` added |
| Lint | `eslint.config.js` | typescript-eslint type-checked rules incl. `no-floating-promises`, `no-misused-promises`, `no-explicit-any` |
| Tests | Vitest + Testcontainers | Real PostgreSQL 17 + Redis 7 containers; migrations applied from an empty DB on every run |
| Dependencies | `package.json` | Removed 23 unused packages (axios, Clerk, svix, Twilio, SendGrid, Resend, nodemailer, bcrypt, jsonwebtoken, @fastify/jwt/oauth2/static, pg, redis, node-cron, …). Upgraded better-auth 1.6.25→1.7.27, fastify 5.10→5.12.8, zod 4.4→4.6.7, sharp 0.34→0.35.5, @fastify/multipart 9→10, swagger-ui, vitest 4.1.12. Added bullmq, pino, @fastify/rate-limit, typescript-eslint. `npm audit --omit=dev`: **0 critical, 0 high** (was 2 critical, 16 high); 4 moderate remain in the dev-only drizzle-kit → esbuild chain |
| Uploads hardening | `modules/uploads` | Owner-tracked `uploads` table; content type detected from bytes; images re-encoded to WebP (keeps transparency, strips metadata); multipart limits enforced by the parser; delete = owner or admin |
| Removed | old `config/`, `middleware/`, `utils/`, `plugins/`, `types/`, all old controllers, booking-payment and payout code, payout cron, SendGrid/SMS notification code, `auth-schema.ts` | Payments/payouts **tables are kept** (no code reads/writes them) |

## 2. Phase 2: vendors and subscriptions (complete)

- **Instant self-service onboarding** (`POST /api/vendors/become`): one transaction locks the user, creates the vendor (`approved`), switches the role to `vendor`, starts the trial and writes an audit record. Idempotent. Admins can't onboard. Requires a verified email.
- **Vendor status and subscription status are separate.** Admin suspension (`approved|suspended`) no longer flips the user to `customer`, so a suspended vendor can't book as a customer. Reinstatement endpoint added.
- **Profile management**, private payout details (owner-only), and public profile with an explicit public projection. Slugs are now stable across renames.
- **Subscriptions**: see section 6.
- **Paystack and Daraja integrations**: subscription payments only; see section 6.

## 3. Phase 3: booking and availability (complete)

- Customer-only requests, enforced by the `customer` guard **and** re-checked in `bookingsService.request`.
- Vendor accept or decline; 24-hour deadline stored in `respond_by`, enforced in the service, by a BullMQ delayed job, and by a 5-minute sweeper.
- Availability: vendor blocks and accepted bookings. Transaction-safe: per-listing row lock plus a **database exclusion constraint** on accepted bookings.
- Status transitions with an append-only `booking_events` audit trail.
- Customer–vendor messaging (booking-scoped), with reporting and moderation.
- Notifications for every booking event and new messages, via the outbox.
- **No booking money**: nothing prices, charges, taxes, holds or settles bookings. Booking fee/VAT columns are no longer written.

## 4. Architecture changes

```
src/
  app/            build-app (assembly), policies (authz), errors, error-handler, http helpers, audit
  platform/       config, logger, database (client, schema, migrations), cache (Redis), queue (BullMQ),
                  mailer (Brevo + templates), storage (Cloudinary/S3), time
  modules/
    identity/     Better Auth config + bridge, OTP
    users/        profile, saved listings, stats, admin customer list
    vendors/      repo, service, routes (onboarding, profile, moderation)
    subscriptions/ service (state machine, plans, lifecycle), routes (vendor + admin)
    payments/     paystack.adapter, daraja.adapter, service (initiate/verify/webhooks/reconcile), routes (webhooks)
    catalog/      listings, categories
    availability/ service, routes
    bookings/     service (lifecycle), routes (customer, vendor, admin)
    messaging/    service, routes (conversations, reports, moderation)
    reviews/      service, routes
    uploads/      routes
    notifications/ outbox writer, dispatcher
  jobs/           processors + schedules
  server.ts       API process        worker.ts   worker process
```

- Two process types from one image: API (`node dist/server.js`) and worker (`node dist/worker.js`).
- Modules call each other through services (`listingsService.lockBookable`, `subscriptionsService.getEntitlement`, `messagingService.openForBooking`). The one deliberate cross-module SQL fragment is `vendorEntitledSql`, exported by subscriptions for catalog visibility.
- Schema files stay in one place (`platform/database/schema`), which avoids the Drizzle circular-import problems the old code worked around. Modules own their *queries*, not table files.
- `repo.ts` was created only where queries are reused (vendors); other services keep their queries local rather than adding empty layers.

## 5. Database schema and migrations

| Migration | Kind | Content |
| --- | --- | --- |
| `0000_baseline` | Phase 0 | Exact current schema (verified identical to the Neon DB) |
| `0001_marketplace_refactor` | generated, **additive** | New enums and tables: `booking_lifecycle_status`, `booking_actor`, `subscription_status`, `subscription_invoice_status`, `payment_provider`, `payment_attempt_status`, `revenue_entry_type`; tables `booking_events`, `subscription_plans`, `vendor_subscriptions`, `subscription_invoices`, `payment_attempts`, `provider_events`, `revenue_entries`, `conversations`, `messages`, `message_reports`, `outbox`, `audit_log`, `uploads`. Bookings: new columns `lifecycle_status`, generated `period daterange`, `respond_by`, `cancelled_by`, `accepted_at`, `declined_at`, `expired_at`, `cancelled_at`; legacy `status` and fee columns made nullable (not dropped) |
| `0002_booking_lifecycle_backfill_and_exclusion` | hand-written | Maps legacy statuses (pending→requested, confirmed→accepted, disputed→cancelled-by-system, legacy value retained); sets `respond_by` for open requests; aborts with a clear error if legacy accepted bookings overlap; `CREATE EXTENSION btree_gist`; exclusion constraint `bookings_no_overlapping_accepted`; `NOT VALID` checks on dates and guests |

- **Nothing is dropped.** `payments`, `payouts`, vendor payout columns, booking fee columns and the legacy booking `status` remain, with no code using them. Removal is a separate, reviewed contract migration.
- **Verified on a disposable database:** every test run starts PostgreSQL 17 empty and applies 0000→0002. This caught one real bug during development (a reserved word in the guard block), which is fixed.
- **Production prerequisites:** the database role must be allowed to `CREATE EXTENSION btree_gist` (Neon: yes; Render: unverified). The baseline must be recorded as applied first (Phase 0 report). Run `0001` and `0002` in a maintenance window: the exclusion-constraint build briefly locks `bookings`.
- `src/platform/database/migrations-legacy/` is historical only.

## 6. Subscription implementation

**States:** `trialing → past_due → active`; `active → past_due` at each period end; `past_due → suspended` after grace; `suspended → expired` after N days; `cancelled` at period end on request; any restricted state `→ active` when paid. Entitled = `trialing | active | past_due`.

| Rule | Implementation |
| --- | --- |
| One month free | `trial_ends_at = addMonthsUTC(onboarding instant, 1)`, with month-end clamping, unit-tested |
| Monthly cycle | Invoice per `(subscription, period_start)`, unique, so renewal is idempotent; `period_end = +1 month` |
| Price | **Admin-configured** plan rows; one active plan (partial unique index); price changes create a new row, and issued invoices keep their amount. **No price is seeded.** With no active plan, billing is *held* (`billing_hold_reason = no_active_plan`) and vendors stay entitled |
| Grace / retries | `SUBSCRIPTION_GRACE_DAYS` (default 7); payment-due reminders on days `0,2,4,6` after due; trial reminders 7/3/1 days before end. All configurable; each reminder sent exactly once (outbox dedupe) |
| Expiry | `SUBSCRIPTION_EXPIRE_AFTER_SUSPENDED_DAYS` (default 30); open invoices voided. Resubscribing issues a fresh invoice starting at payment |
| Cancellation | Trialing/active: at period end. Past-due/suspended: immediate, open invoice voided. Undo before effect |
| Restrictions | Not entitled: listings hidden (search, detail, slug, featured, public profile), publishing blocked, accepting requests blocked, new requests impossible. Still allowed: profile, billing, declining requests, existing accepted bookings, messaging |
| Payment history | `GET /api/subscriptions/me/invoices`, `/me/payments` |
| Revenue accounting | Append-only `revenue_entries` (one positive entry per verified payment; reversal/refund types reserved, negative, by constraint). Revenue report sums the journal, never payment statuses |

**Payments (subscriptions only):**
- Attempt row created *before* the provider call; idempotency per `Idempotency-Key` header, plus reuse of an in-flight attempt for the same invoice and provider (no double STK prompts).
- **Paystack:** hosted checkout (`/transaction/initialize`), webhook HMAC-SHA512 over the raw body with constant-time comparison, **credit only after `/transaction/verify`** confirms success and the exact amount and currency. Optional saved-card renewals (`charge_authorization`), only behind `PAYSTACK_RECURRING_ENABLED`, vendor opt-in, and a `reusable` authorization; also verified before credit.
- **Daraja:** STK Push (password = base64(shortcode+passkey+timestamp), EAT timestamp, ≤12-char account reference). Callbacks are unsigned, so they are authenticated by a secret path token (constant-time) plus an optional IP allow-list, stored, and **always confirmed via STK Query** before credit. No automatic recurring M-Pesa deduction: each cycle is a vendor-approved STK request.
- `provider_events` are unique per provider event: duplicates are acknowledged and ignored.
- Amount or currency mismatch: attempt failed, audit entry, nothing credited. Payment for an already-settled invoice: recorded with `requires_review = true`, no access change.
- Reconciliation (every 10 minutes): re-verifies stale pending attempts, closes abandoned ones (Paystack 24 h, STK 60 min), retries unprocessed provider events.
- **Not production-verified:** the adapters follow the providers' documented APIs and are covered by request-shape unit tests and integration tests with deterministic fakes, but they have **not been run against Paystack or Safaricom sandboxes** (no credentials). Do a sandbox run before enabling either provider.

## 7. Booking implementation

- **States:** `requested`, `accepted`, `declined`, `expired`, `cancelled`, `completed`. There is no `confirmed` and no payment state.
- **Request:** listing must be active, vendor approved and entitled; dates valid (no past start in Nairobi time, ≤366 days); no blocked or accepted overlap; no duplicate open request; at most `BOOKING_MAX_OPEN_REQUESTS_PER_CUSTOMER` (5) open requests. `respond_by = now + 24h`. Pricing type and currency snapshot only.
- **Accept:** under a booking row lock and a listing row lock, re-checks the deadline (an overdue request is expired *and committed*, then 409 `REQUEST_EXPIRED`), vendor status, entitlement, blocks and accepted overlap. The exclusion constraint is the final guard. Overlapping open requests are auto-declined ("Dates no longer available"). A conversation is opened.
- **Decline:** reason required (10+ characters). **Cancel:** customer (requested/accepted) or vendor (accepted), before the start date, reason required.
- **Expiry:** delayed BullMQ job per request (`jobId = expire-<id>`, so it dedupes) plus a 5-minute sweeper; both idempotent.
- **Completion:** worker marks accepted bookings `completed` 2 days after the end date (configurable). This enables reviews and increments `bookings_count`. No money involved.
- **Privacy:** customer email/phone and vendor phone are shared with the other party only once accepted.
- **Messaging:** opens on accept; writable while accepted and for 30 days after completion; read-only after cancel, decline or expire. 2,000-character text; 20/min rate limit; report message; admin hide/dismiss (audited). Admins can read but not post. Polling API (no websockets).

## 8. Security and authorization

- **Phase 0 fixes carried forward:** seed-admin removed; `NODE_ENV` required; payout-detail leaks closed; drafts and deleted listings hidden; KYC upload removed; destructive npm scripts removed.
- New guarantees: role checks centralised and re-checked in services; vendor ownership resolved from the session, never from client input. Another vendor's resource returns **404**, so no ownership oracle. Suspended and unentitled vendors restricted consistently. Better Auth endpoints that bypass invariants are blocked at the bridge (`set-role`, `create-user`, `remove-user`, `impersonate-user`, `stop-impersonating`, `set-user-password`, `update-user`).
- OTP hardened: CSPRNG, constant-time comparison, 5 attempts per code, 20 failures/day per user, resend throttle.
- All email templates escape interpolated values.
- Webhook endpoints are the only unauthenticated writes and each is authenticated (HMAC or secret token) and verified with the provider.
- `TRUST_PROXY` defaults to false (client IPs can't be spoofed via headers unless you opt in behind your proxy).
- **Still open:** git history purge and Render password rotation (owner action, Phase 0).

## 9. Test results

Recorded from the final run (see section at end of file: *Verification log*).

| Suite | Files | Tests |
| --- | --- | --- |
| Unit | 2 | 17 |
| Integration (real Postgres + Redis) | 4 | 50 |

Coverage by required area: authentication and role permissions; vendor onboarding; trial creation; trial expiration (with and without a plan); monthly renewal; failed subscription payments; customer-only booking creation; vendor accept/decline; 24 h expiry (service-level, job, sweeper idempotency); payment-after-acceptance **N/A by business decision** (tests assert no booking payment fields and no payment state); Paystack webhooks (valid, forged, duplicate, unverified, amount mismatch); Daraja callbacks (bad token, duplicate, processing, success, user-cancelled); payment verification; availability conflicts (blocked dates, accepted overlap, concurrent accepts, DB exclusion constraint); cross-vendor and cross-customer access; suspended vendor restrictions; unauthorised vendor/admin booking attempts; messaging access and moderation.
**Not applicable or not yet tested:** refunds (none processed: Phase 4 scope); ledger for booking money (removed by business decision); payouts (removed); BullMQ worker end-to-end under a live worker process (processors are tested directly; job scheduling is asserted).

**Environment note:** on this Windows machine Vitest must be started from a shell whose working directory uses an upper-case drive letter (`D:\...`). Git Bash's `/d/...` path loads two copies of Vitest and every file fails with "failed to find the runner". CI on Linux is unaffected.

## 10. Remaining D1–D12 decisions

| # | Decision | What is implemented now | Your confirmation needed |
| --- | --- | --- | --- |
| D1 | Restrictions when unpaid | Default applied (reversible): hidden listings, no publishing, no accepting; drafts, billing, declining, accepted bookings and messaging still allowed | Confirm |
| D2 | Grace and retry schedule | Defaults applied, all env-configurable (7-day grace, reminders 0/2/4/6, expire after 30 days suspended) | Confirm values |
| D3 | **4 existing vendors** | **Not decided, not changed.** They have no subscription row and are treated as entitled (`legacy_unenrolled`). Listed at `GET /api/admin/subscriptions/unenrolled`; an admin can enrol one at a time (trial starts at enrolment) | **Required**: choose a policy (e.g. trial from Phase-2 deploy date, from onboarding date, or a grace offer), then enrol |
| D4 | Paystack saved-card renewals | Implemented behind `PAYSTACK_RECURRING_ENABLED=false` + vendor opt-in | Approve before enabling |
| D5 | Price changes | New plan applies to invoices issued after activation (each vendor's next period) | Confirm |
| D6 | Currency | KES only (plan API accepts only KES; schema supports more) | Confirm |
| D7 | Cancellation and refunds | Cancel at period end; no automatic refunds (refunds are Phase 4) | Confirm |
| D8 | Booking price snapshot | Only pricing type and currency are snapshotted; no amounts | Confirm (or request a non-binding quoted price) |
| D9 | Vendor payout details | **Kept unchanged**, private to the vendor, never exposed. No payouts exist | Decide: drop later, or repurpose (e.g. payment instructions shown to accepted customers) |
| D10 | Requests block dates? | No; only acceptance reserves; overlapping requests auto-declined on accept | Confirm |
| D11 | Completion | Auto-complete 2 days after end date (configurable); no vendor/customer "mark complete" yet | Confirm |
| D12 | Messaging scope | Text-only polling, 30-day post-completion window, report + hide | Confirm |
| D13 | Which DB is production | Unverified (Neon vs Render) | **Required** before any production migration |
| New | Email verification for booking and onboarding | Now required (abuse control) | Confirm |
| New | Price per subscription in whole shillings | Enforced (M-Pesa can't charge cents) | Confirm |

## 11. Production deployment requirements

1. Owner actions from Phase 0: rotate the Render DB password; confirm the production database; confirm `NODE_ENV=production` per service.
2. Configure secrets per `.env.example` (all documented). Required: `NODE_ENV`, `API_PUBLIC_URL`, `FRONTEND_URL`, `CORS_ORIGINS`, `COOKIE_SECRET`, `DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, Brevo (`MAIL_TRANSPORT=brevo` is mandatory in production), storage.
3. Database, with approval: back up; record the baseline as applied (Phase 0 SQL); run `node dist/scripts/migrate.js` (applies 0001, 0002) in a maintenance window; verify `bookings_no_overlapping_accepted` exists.
4. Deploy **two services** from the image: API (default command) and worker (`node dist/worker.js`). At least one worker is required, or expiries, completions, reminders and notifications stop.
5. Redis must be persistent (BullMQ delayed jobs). Use a `QUEUE_PREFIX` per environment.
6. Payments, when credentials arrive: Paystack webhook URL `{API_PUBLIC_URL}/api/payments/paystack/webhook`; Daraja callback `{API_PUBLIC_URL}/api/payments/daraja/callback/{DARAJA_CALLBACK_TOKEN}` (HTTPS, publicly reachable). Sandbox-test both, then set `*_ENABLED=true`.
7. Create and activate the subscription plan (`POST /api/admin/subscriptions/plans`) **only after** the price is decided; until then billing is held.
8. Enrol the 4 legacy vendors per the D3 decision.
9. Set `TRUST_PROXY=true` only behind your load balancer; keep `SWAGGER_ENABLED=false` in production.
10. Run `npm audit --omit=dev`, `npm run lint`, `npm run typecheck` and `npm test` in CI (Docker required for tests).

## 12. Frontend integration requirements (API changes)

**Error shape (all endpoints):** `{ success: false, error: string, code: string, details?, requestId }`. `error` stays a string; branch on `code`. Validation errors are now **422** with `details[]` (some were 400).

| Area | Change |
| --- | --- |
| Booking statuses | `pending→requested`, `confirmed→accepted`; new `expired`. List filters accept the legacy names. Responses include `respondBy` (for requested) and `paymentNote` |
| Booking creation | Needs a **verified** customer; non-customers get 403 `CUSTOMERS_ONLY`. Response is the full booking view (201). No amounts returned |
| Booking actions | Unchanged paths (`PUT /api/bookings/:id/accept`, `/decline`, `/cancel`); `cancel` now works for vendors too (accepted bookings). Accepting an expired request: 409 `REQUEST_EXPIRED`; dates taken: 409 `DATES_UNAVAILABLE`. New `GET /api/bookings/:id/events` |
| Contact details | Customer email/phone and vendor phone appear only after acceptance |
| Messaging (new) | `GET /api/conversations`, `GET /api/conversations/by-booking/:bookingId`, `GET/POST /api/conversations/:id/messages` (`?after=` for polling), `POST /api/messages/:id/report` |
| Vendor onboarding | `POST /api/vendors/become` requires a verified email; optional body `{ businessName, phoneNumber }`; 201 created / 200 existing; response includes the trial message |
| Subscriptions (new) | `GET /api/subscriptions/payment-methods`, `GET /api/subscriptions/me`, `/me/invoices`, `/me/payments`, `POST /me/payments` (`{provider:'paystack'}` → redirect to `checkoutUrl`; `{provider:'mpesa', phone}` → show "check your phone"), then poll `GET /me/payments/:id` until `succeeded/failed/cancelled`. Send an `Idempotency-Key` header. `POST /me/cancel`, `/me/resume`, `PATCH /me/auto-renew` |
| Restricted vendors | 403 codes `VENDOR_SUSPENDED`, `SUBSCRIPTION_INACTIVE` |
| Listings | Search returns `total`; slugs no longer change on rename; `currency` must be `KES`; deleting a listing with open/upcoming bookings returns 409 `LISTING_HAS_BOOKINGS` |
| Availability | Calendar shows `Unavailable` instead of the vendor's private block reason |
| Uploads | `POST /api/upload/image(s)` field `uploadType` ∈ `listing_photo, vendor_logo, profile_photo` (vendor-only for the first two); images return WebP; `DELETE /api/upload/file` body `{ publicId }`, owner only. `POST /api/upload/document` removed |
| User stats | `GET /api/users/me/stats` no longer returns `spent`; counts per new status |
| Removed | `/api/payouts/*`, `/api/admin/payouts/*`, `/api/dev/seed-admin`, `/api/upload/document` |
| Admin (new) | `/api/admin/vendors/:id/reinstate`, `/api/admin/subscriptions` (list, plans, unenrolled, enrol, revenue), `/api/admin/messages` (reports, moderate), `/api/admin/bookings/:id` includes events |
| Auth | Cookie-based Better Auth unchanged; CORS origins now from `CORS_ORIGINS` |

---

## Verification log

Final run, 2026-11-24, on Windows 11 + Docker 29.9 (Testcontainers: postgres:17-alpine, redis:7-alpine):

| Gate | Command | Result |
| --- | --- | --- |
| Type-check | `npm run typecheck` | pass, 0 errors; no `any`, `@ts-ignore` or `@ts-expect-error` in `src/` |
| Lint | `npm run lint` | pass, 0 problems (type-checked rules) |
| Tests | `npm test` | **6 files, 67 tests, all passed** (17 unit, 50 integration), 208 s |
| Migrations on a disposable DB | global test setup applies 0000→0002 to an empty PostgreSQL 17 | pass |
| Schema ↔ migrations drift | `drizzle-kit check`; `drizzle-kit generate` | "Everything's fine"; "No schema changes, nothing to migrate" |
| Production build | `npm run build` | pass (`dist/server.js`, `dist/worker.js`, `dist/scripts/migrate.js`, `dist/scripts/promote-admin.js`) |
| Dependency audit | `npm audit --omit=dev` | 0 critical, 0 high, 4 moderate (esbuild via dev-only drizzle-kit) |

Bugs found by the tests during development, now fixed: a reserved word (`overlaps`) in migration 0002; a `Date` bound into a raw SQL fragment in auto-completion; `POST /api/vendors/become` (and the admin suspend/reinstate routes) rejecting an empty body.

### Repository state

- Working on the existing branch, which was **renamed outside this session** from `refactor/option-b` to `refactor` and pushed as `origin/refactor`. Commit `40da6a3 "production safety and baseline"` was also made outside this session. Phases 1–3 are **uncommitted** in the working tree.
- Untracked local scripts left untouched and excluded from compilation and lint: `src/db/clear.ts` (TRUNCATE-all), `src/tests/test-email.ts`, `scripts/add-js-extensions.mjs`. Consider deleting `clear.ts`.
- Pre-existing working-tree deletions outside `backend/` (root `.gitignore`, `docs/Guide.txt`, `prompt.txt`) were not touched.
