# LinkMart backend operations runbook

For whoever operates the API and worker in staging or production. Every endpoint below requires an **admin**
session and is audited where it changes anything.

## Processes
- **API**: `node dist/server.js`. Stateless; scale horizontally.
- **Worker**: `node dist/worker.js`. At least **one** must run. Without a worker nothing below happens: booking
  expiry, auto-completion, subscription lifecycle, payment reconciliation, email delivery. Several workers are safe
  (jobs are idempotent; outbox rows are claimed with `SKIP LOCKED` leases).
- Both shut down gracefully on `SIGTERM` (30 s budget). Unfinished jobs are picked up again as *stalled* by another worker.

## Is everything healthy?
`GET /api/admin/operations/health`:

| Field | Healthy | If not |
| --- | --- | --- |
| `database` | `true` | API is not ready (`/ready` returns 503). Check `DATABASE_URL` and the DB service |
| `redis` | `true` | Cache and rate limiting degrade (the API keeps serving). Queues pause until Redis returns |
| `alive` / `workers[]` | ≥1 worker seen in the last 60 s | Start or restart the worker service |
| `queues[].counts.failed` | 0 or stable | See "Failed jobs" |
| `outbox.pending`, `oldestPendingAt` | small, recent | Worker not running or email provider down |
| `outbox.deadLettered` | 0 | See "Failed notifications" |
| `payments.awaitingReview` | 0 | See "Payment investigation" |
| `payments.unprocessedProviderEvents` | 0, or briefly > 0 | Reconciliation retries every 10 minutes |

## Schedules (BullMQ job schedulers, upserted on every worker start)
| Job | Every | Does |
| --- | --- | --- |
| `booking.sweep-expired-requests` | 5 min | Expires requests past `respond_by` (backstop for the per-booking delayed job `expire-<bookingId>`) |
| `booking.auto-complete` | 60 min | Accepted bookings → `completed`, `BOOKING_AUTO_COMPLETE_DAYS` after the end date |
| `subscriptions.tick` | 15 min | Trial end, renewals, grace → suspended → expired, reminders, (saved-card renewals only if approved) |
| `payments.reconcile-pending` | 10 min | Re-verifies pending payments, closes abandoned ones, retries stored provider events |

Each run processes rows independently. A bad row is logged (`batch item failed`) and retried on the next run,
without blocking the others.

## Failed jobs
1. `GET /api/admin/operations/queues/bookings/failed` (or `/scheduler/failed`) lists failed jobs with
   `failedReason` and `attemptsMade`. Jobs retry 5 times with exponential backoff before landing here, and stay
   7 days.
2. Fix the cause (logs: search for `job failed permanently` with the job `id`).
3. `POST /api/admin/operations/queues/:queue/jobs/:jobId/retry`. Safe: every processor re-checks state.
   For the scheduler queue you can also just wait: the next scheduled run does the same work.

## Failed notifications (emails)
- Delivery is at least once with exponential backoff (8 attempts, up to 1 h apart). Rows that exhaust their
  retries, or can never be delivered (unknown topic), are **dead-lettered** (`failed_at`). Logs:
  `outbox notification dead-lettered`.
- List: `GET /api/admin/operations/outbox?state=failed` (`state=retrying` shows rows still being retried).
- After fixing the cause (e.g. Brevo key or quota): `POST /api/admin/operations/outbox/:id/retry`. Emails already
  sent for that row (`deliveredCount`) are not sent again.

## Payment investigation (subscription payments only)
- Review queue: `GET /api/admin/payments?needsReview=true`. Reasons: amount, currency or reference mismatch;
  payment for an invoice that was already settled (e.g. paid twice); provider reversal or refund; dispute.
- Detail: `GET /api/admin/payments/:id` (attempt, invoice, stored provider events, revenue journal, audit trail).
- Ask the provider again: `POST /api/admin/payments/:id/reverify`. Only the provider's verified answer is applied.
- Close: `POST /api/admin/payments/:id/review { note }`. **This never moves money or changes a vendor's access.**
  Refunds, if any, are made in the Paystack dashboard or by M-Pesa reversal, outside LinkMart (no approved refund policy).
- Unmatched provider events (a webhook or callback whose reference matches no payment, kept after 60 minutes of
  retries): `GET /api/admin/payments/provider-events?state=unmatched`.
- Vendor billing overview: `GET /api/admin/subscriptions/vendors/:vendorId`.

## Redis outage
- API: cache misses served from the database. Rate limiting is skipped (`skipOnError`). Booking requests still
  succeed; their expiry job may fail to enqueue (logged, bounded to 2 s), and the 5-minute sweeper covers it.
- Worker: BullMQ waits and reconnects. Delayed jobs and schedules survive in Redis, so **Redis must be persistent**
  (AOF or RDB). Don't use an eviction policy other than `noeviction` for the queue Redis.

## Database rollbacks
Every state change (and its audit and outbox rows) commits in one transaction or not at all. `audit_log`,
`booking_events` and `revenue_entries` are append-only by database trigger: corrections are new rows.

## Logs
JSON (pino). Every API line has `reqId`, and responses echo `X-Request-Id`. Secrets, cookies, signatures, card
authorization codes, OTPs and payout numbers are redacted. Useful messages: `job failed`, `job stalled`,
`outbox delivery failed`, `outbox notification dead-lettered`, `payment initiation failed`,
`provider event processing failed`, `reconciliation verify failed`, `batch item failed`, `worker heartbeat failed`.
