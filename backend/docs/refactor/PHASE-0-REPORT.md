# Phase 0 report: production safety and baseline

Status: code changes complete on branch `refactor/option-b` (uncommitted). Database: **no changes made anywhere**.
Date: 2026-11-24.

## 1. Exposed secrets

| Item | Finding | Action taken | Action required from owner |
| --- | --- | --- | --- |
| Render Postgres credentials | Full connection string (host, user, password) in `backend/fix-enum.js`, committed in `2fbdcc0`, pushed to `origin/main`. **The GitHub repository is public** (GitHub API returns 200 without auth). | File deleted from the working tree. | **Rotate the Render database password now.** Treat the database as compromised: review its users, roles and recent connections. Then run the history purge below. |
| Password hash + user ids | `backend/debug-account-insert.ts` contained an account password hash and real user/account UUIDs. | File deleted. | Reset the password of that account. |
| DB URL logging | `drizzle.config.ts` printed `DATABASE_URL` (with password) on every drizzle-kit run. | Log removed. | Check CI or build logs that may hold it. |
| `.env` | Never committed (verified with `git log --all -- backend/.env`). | None. | n/a |

### History purge (separate, planned operation: not performed)

Rewriting public history is destructive and needs explicit approval. Rotation (above) is what removes the risk. The purge only stops further copying.

1. Rotate credentials first (purging does not invalidate copies already cloned or cached).
2. Freeze pushes; tell collaborators.
3. Fresh mirror clone: `git clone --mirror https://github.com/Brian-Rotich20/Hospitality-saas-platform.git`
4. `git filter-repo --invert-paths --path backend/fix-enum.js --path backend/debug-account-insert.ts`
5. Verify: `git log --all -p | grep -c "render.com"` returns 0.
6. `git push --force --mirror`; ask GitHub Support to purge cached views and PR refs.
7. Every collaborator re-clones. Old clones must not be pushed again.

## 2. Code changes (containment)

| Finding | Change | Files |
| --- | --- | --- |
| S2 unauthenticated admin creation | `POST /api/dev/seed-admin` removed. Replaced by operator CLI `npm run admin:promote -- <email>` (existing, verified, non-vendor users only; no HTTP surface). | `src/app.ts`, `src/scripts/promote-admin.ts`, `package.json` |
| `NODE_ENV` default | `NODE_ENV` is now required; the app refuses to boot without it. | `src/config/env.ts` |
| Cookie secret fallback | Removed the `'changeme'` fallback (it was unreachable but misleading). | `src/app.ts` |
| S3 payout-detail leak | Public vendor profile returns an explicit public projection; new cache key `vendor:public:v2:*` so old full-row cache entries are never served. Booking detail embeds only public vendor fields. | `vendors.service.ts`, `bookings.service.ts` |
| S14 hidden listings | `GET /listings/:id` serves only active listings of approved vendors, except to the owning vendor (owner may view own drafts; deleted never). Only public results are cached. Slug lookup: active + approved only. A deleted listing can no longer be re-activated via the status endpoint. Status changes now clear the slug cache. | `listings.service.ts`, `listings.controller.ts`, `auth.middleware.ts` (`getOptionalUserId`) |
| Z2 suspended vendors | Search and featured exclude suspended vendors; new booking requests to a suspended vendor's listing are rejected; a suspended vendor can't accept requests. (Publishing was already blocked.) | `listings.service.ts`, `bookings.service.ts`, `bookings.controller.ts` |
| S5 any user could delete any file | `DELETE /api/upload/file` is admin-only until uploads are owner-tracked (Phase 1). | `upload.routes.ts`, `upload.schema.ts` |
| Pre-existing bug found | `DELETE /api/upload/file` returned **500 for every request**: a JSON-schema body under the Zod validator compiler. Now a Zod schema; auth runs in `preValidation`. | `upload.routes.ts` |
| S6 public KYC | `POST /api/upload/document` removed: it put identity documents on public storage and persisted nothing; self-service onboarding requires no KYC. | `upload.routes.ts` |
| Destructive scripts | Removed `db:push`, `db:reset` (`push --force`), `seed:reset`, `db:seed` (missing file), `db:clear` (TRUNCATE all). Added `typecheck`, `db:check`, `admin:promote`. | `package.json` |

### Known regressions (frontend may be affected; frontend not changed)

- Calls to `POST /api/upload/document` now 404.
- Non-admin calls to `DELETE /api/upload/file` now 403 (they previously failed with 500 anyway).
- `GET /api/listings/:id` and `/slug/:slug` no longer return drafts, paused or deleted listings to the public. Owners still get their own drafts by id when the session cookie is sent.

## 3. Database baseline

### Which database was inspected

`backend/.env` `DATABASE_URL` points at a **Neon** Postgres 18 instance. It is a different server from the Render database whose credentials leaked.
**Whether the Neon database is production is UNVERIFIED.** The Render database was not inspected (its credentials are compromised and its role is unconfirmed).
All inspection ran inside `BEGIN READ ONLY` transactions.

### Facts (Neon database, 2026-11-24)

| Fact | Value |
| --- | --- |
| `payments` rows | 0 |
| `payouts` rows | 0 |
| `users` where `role='admin'` | 1 |
| users / vendors / listings | 9 / 4 / 4 (3 active, 1 deleted) |
| bookings / reviews / availability / saved_listings | 0 / 0 / 0 / 0 |
| categories / sessions / accounts | 22 / 69 / 9 (8 credential, 1 google) |
| vendors with payout details | 0 |
| vendors by status | 4 approved |
| `drizzle.__drizzle_migrations` | exists, **0 rows**: schema was created with `drizzle-kit push`, never migrated |

### Drift resolution

- The 14 legacy migrations do **not** describe this database (they create `products*`, `vendor_documents`, a 5-value `vendor_status`). They describe an older or other database, probably the Render one.
- The TypeScript schema matches the Neon database **exactly**. A scripted comparison of 13 tables and 8 enums (every column, type, varchar length, numeric precision, nullability, index, FK and unique constraint) found no differences.
- Legacy migrations moved to `src/db/migrations-legacy/` (kept for history, never run).
- New baseline: `src/db/migrations/0000_baseline.sql` (journal `when=1795528241566`, sha256 `8b14d6bb1fca18b8ffe992eda026351f4ac38661049cc12a7f150907af8d7d2e`).
- `.gitattributes` pins migration files to LF; drizzle hashes the file text, so CRLF conversion would break tracking.

### Adopting the baseline on an existing database (requires approval: write operation)

The baseline must be **recorded as applied**, never executed, on a database that already has the tables:

```sql
BEGIN;
-- 1. Confirm the database is the expected one and untracked
SELECT count(*) FROM drizzle.__drizzle_migrations;            -- expect 0
-- 2. Record the baseline as applied
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('8b14d6bb1fca18b8ffe992eda026351f4ac38661049cc12a7f150907af8d7d2e', 1795528241566);
COMMIT;
```

After that, `npm run db:migrate` applies only later migrations. A fresh database (CI, tests, staging) simply runs `db:migrate` from zero.
Before adopting it on any other database (e.g. Render), re-run the comparison script against that database first.

### Production facts SQL (for the database you confirm as production)

```sql
BEGIN READ ONLY;
SELECT count(*) AS payments FROM payments;
SELECT count(*) AS payouts  FROM payouts;
SELECT count(*) AS admins   FROM users WHERE role = 'admin';
SELECT count(*) AS applied_migrations FROM drizzle.__drizzle_migrations;
SELECT t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder)
  FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'vendor_status' GROUP BY 1;
COMMIT;
```

## 4. NODE_ENV across deployed services: UNVERIFIED

No access to the hosting dashboards. Known: local `.env` = `development`; `Dockerfile` sets `production`; `compose.yaml` sets `production`. The app now refuses to start without `NODE_ENV`, so a missing value fails loudly instead of enabling development behaviour.
Owner to confirm for each deployed backend service: `NODE_ENV=production`.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | pass (0 errors) |
| `npm run build` | pass |
| Lint | **not runnable**: ESLint 9 is installed but no `eslint.config.js` exists (Phase 1) |
| Tests | none exist yet (Phase 1 builds the harness) |
| Smoke test (built app, `app.inject`, write-free routes only) | 6/6 pass: `/health` 200; seed-admin 404; unknown vendor 404; unknown listing 404; KYC upload 404; file delete without session 401 |

## 6. Outstanding from Phase 0

- Owner: rotate Render DB password; confirm which DB is production; confirm `NODE_ENV` per service; approve the history purge and the baseline adoption.
- Suspension still flips `users.role` to `customer`, so a suspended vendor's user could book as a customer. This is fixed by the Phase 2 vendor-status redesign.
- Dependency upgrades (`better-auth`, `fastify`, `axios`, `zod`, `sharp`) are deferred to Phase 1 so they land behind tests.
- `backend/.gitignore` is untracked and ignores `test/` and `*.test.ts`; Phase 1 fixes it so tests can be committed.
