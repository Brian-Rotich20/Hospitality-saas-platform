# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

LinkMart: a marketplace backend that connects customers with hospitality vendors. All code lives in `backend/` (Fastify 5 + TypeScript ESM, Drizzle ORM on PostgreSQL, Redis/BullMQ, Better Auth). There is no frontend in this repo.

**Business model, enforced everywhere:** customers pay vendors directly, outside the platform. LinkMart processes **only vendor subscription payments** (Paystack, M-Pesa/Daraja STK Push). Bookings carry no money: nothing prices, charges, holds or settles them. The legacy `payments`/`payouts` tables and booking fee columns still exist, but no code reads or writes them. Do not add booking payments back.

Background and open decisions are in `backend/docs/refactor/` (`PLAN.md`, `PHASE-0-REPORT.md`, `IMPLEMENTATION-REPORT.md`, which includes the API contract changes for the frontend).

## Commands (run from `backend/`)

```bash
npm run dev            # API with tsx watch (src/server.ts)
npm run dev:worker     # worker with tsx watch (src/worker.ts); needed for expiries, reminders, notifications
npm run typecheck      # tsc --noEmit
npm run lint           # eslint, type-checked rules
npm run build          # rimraf dist && tsc -p tsconfig.build.json
npm test               # all tests (needs Docker running)
npm run test:unit      # test/unit only (still runs the container global setup)
npm run test:integration
npx vitest run test/integration/bookings.test.ts      # single file
npx vitest run test/integration/bookings.test.ts -t "accept"   # single test by name
docker compose up --build   # local Postgres 17 + Redis 7 + migrate + api + worker
npm run admin:promote  # promote a user to admin
```

- Tests use **Testcontainers**: `test/setup/global-setup.ts` starts fresh PostgreSQL and Redis containers, applies every migration to an empty database, and sets the test env (`MAIL_TRANSPORT=memory`, rate limits off, fake provider credentials). Docker must be running. Test files run serially (`fileParallelism: false`) because they share one database.
- **Windows:** start Vitest from a shell whose working directory has an upper-case drive letter (`D:\...`, e.g. PowerShell). From Git Bash's `/d/...` path, Vitest loads twice and every file fails with "failed to find the runner".
- Integration tests go through the real HTTP stack: `test/helpers/app.ts` (`getApp`, `call`, `signUp`, `lastOtpFor`) uses `app.inject` with real Better Auth cookies. Payment providers are faked in `test/helpers/fake-providers.ts`.

## Database and migrations

- Schema: `src/platform/database/schema/*.ts` (all tables in one place; modules own queries, not table files). Migrations: `src/platform/database/migrations/`.
- Workflow: edit the schema, then `npm run db:generate`, then `npm run db:check`. Hand-written SQL migrations are allowed (see `0002_...`, which adds the `btree_gist` exclusion constraint `bookings_no_overlapping_accepted`).
- **Never use `drizzle-kit push`.** It is deliberately not a script. Migrations are the only way to change the schema. Releases run `node dist/scripts/migrate.js`.
- Migrations are expand-only: nothing is dropped. Removing legacy columns or tables needs its own reviewed migration.
- `src/platform/database/migrations-legacy/` is historical only. `src/db/` and `src/tests/` hold untracked local scripts that are excluded from build and lint (`src/db/clear.ts` truncates everything; don't run it).

## Architecture

Two process types are built from one image: the **API** (`src/server.ts` → `app/build-app.ts`) and the **worker** (`src/worker.ts` wires signals around `jobs/runtime.ts`: BullMQ consumers, repeatable schedules from `jobs/processors.ts`, the outbox dispatcher loop and a liveness heartbeat; tests start and stop the runtime directly). Both shut down gracefully on SIGTERM. Operator procedures are in `backend/docs/operations/RUNBOOK.md`.

- `src/app/`: HTTP assembly only, with no business logic. `build-app.ts` registers plugins and mounts each module's routes under `/api/...` (admin routes under `/api/admin/...`). `policies.ts` holds authorization. `errors.ts` and `error-handler.ts` provide the typed `AppError` hierarchy and a single handler that maps Postgres codes (23505/23P01 → 409, 23503 → 422, 22P02 → 400, 57014 → 503). `http.ts` has shared Zod pieces (`idParams`, `pagination`, `calendarDate`) and the `ok()` response wrapper. `audit.ts` writes the audit log.
- `src/platform/`: infrastructure. `config/env.ts` is the **only** place that reads `process.env` (a single Zod schema that fails fast at startup), so add new settings there and to `.env.example`. It also has `database/client.ts` (`db`, `withTransaction`, the `Db` type that accepts a db or a tx), `cache/redis.ts` (cache ops time out and degrade to misses), `queue/`, `mailer/` (Brevo; `memory`/`log` transports), `storage/` (Cloudinary/S3), `logger.ts` (pino), and `time.ts` (calendar dates are Africa/Nairobi; `addMonthsUTC` clamps to month end).
- `src/modules/<name>/`: `routes.ts` (Fastify plugin with Zod schemas for params, query and body on every route) and `service.ts` (business logic). Modules call each other **through services** (e.g. `listingsService.lockBookable`, `subscriptionsService.getEntitlement`). The one shared SQL fragment is `vendorEntitledSql` from subscriptions. Add a `repo.ts` only when queries are reused (currently just vendors).

### Conventions that span files

- **Authorization:** routes attach `preValidation: guards.<user|verifiedUser|customer|vendor|activeVendor|entitledVendor|admin>`, then read context with `requireUser(request)` / `requireVendorCtx(request)`. Services re-check critical rules. Vendor ownership always comes from the session, never from client input. Another party's resource returns **404**, not 403.
- **State changes** run in `withTransaction` with `FOR UPDATE` row locks. Notifications are written to the `outbox` table **inside the same transaction** (with dedupe keys) and sent later by the worker. Don't send email directly from request handlers. The dispatcher leases rows, records `delivered_count` per email so retries never re-send, and dead-letters (`failed_at`) after 8 attempts or on a `PermanentDeliveryError`; admins retry via `/api/admin/operations/outbox`.
- **Batch jobs** (lifecycle ticks, sweepers) wrap each row in `eachIsolated` (`platform/batch.ts`) so one bad row never stops the run. Queue calls on request paths go through `withQueueTimeout` (Redis down must not hang a request).
- **Append-only tables:** `audit_log`, `booking_events` and `revenue_entries` reject UPDATE/DELETE via database triggers (migration 0003). Corrections are new rows.
- **Booking lifecycle:** `requested → accepted | declined | expired | cancelled`, then `accepted → completed`. Vendors have a 24h deadline (`respond_by`), which is enforced in the service, by a delayed BullMQ job (`jobId = expire-<id>`), and by a sweeper. Every transition appends to `booking_events`. The legacy names `pending`/`confirmed` are accepted as filter aliases only.
- **Subscriptions:** `trialing → active ⇄ past_due → suspended → expired`, plus `cancelled`. "Entitled" means trialing, active or past_due. Unentitled vendors' listings are hidden, and they can't publish or accept requests. Price comes from admin-created plan rows, never from config. With no active plan, billing is held and vendors stay entitled.
- **Payments:** a payment attempt is recorded before the provider call, with `Idempotency-Key` support. Credit only after server-side verification: Paystack `/transaction/verify` after an HMAC-checked webhook, or Daraja STK Query after a secret-token callback. Revenue goes in the append-only `revenue_entries` table. A succeeded or reversed payment is never re-credited or downgraded. Anything that needs a human (amount/reference mismatch, paid-twice, refund/reversal, dispute) sets `payment_attempts.requires_review`; reviews never move money or change access (`/api/admin/payments`). Stored provider payloads are sanitised (`sanitizeProviderPayload`). Neither adapter has been run against a real sandbox yet.
- **API docs:** `docs/api/openapi.json` is generated (`npm run openapi:export` with `SWAGGER_ENABLED=true` and placeholder env), and `test/integration/openapi.test.ts` fails if it drifts from the routes. Human docs: `docs/api/API-REFERENCE.md`, `docs/api/FRONTEND-INTEGRATION-GUIDE.md`.
- **Rate limits** key on `user:<id>` when the session is valid (resolved once per request by `getAuth`, shared with the guards) and `ip:<client ip>` otherwise. `TRUST_PROXY` is `false`, a hop count or proxy CIDRs, never `true`. The auth bridge overwrites `X-Forwarded-For` with `request.ip` before calling Better Auth.
- **Auth behind the frontend proxy:** `BETTER_AUTH_URL` is the frontend origin and must be in `CORS_ORIGINS`. Better Auth origin checks are forced on in tests (`disableOriginCheck: false`). Password reset uses Better Auth's flow; the email goes through the outbox (`auth.password_reset`, token scrubbed after delivery, redacted in the ops API).
- **Error response shape:** `{ success: false, error, code, details?, requestId }`. Validation errors are 422. Clients branch on `code`.

### Lint and TS rules worth knowing

The tsconfig sets `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. ESLint errors on `any`, floating or misused promises, non-`import type` type imports (use inline `type` specifiers), and `console.*` other than `console.error` (use the pino `logger`). Relative imports must use `.js` extensions (NodeNext ESM).
