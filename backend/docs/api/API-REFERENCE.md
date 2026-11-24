# LinkMart API reference (backend v2)

This describes the API exactly as implemented on branch `refactor`. The machine-readable source is
[`openapi.json`](./openapi.json). It is generated from the live route schemas with `npm run openapi:export`,
and a test fails if it falls out of date. Interactive docs are served at `/docs` when `SWAGGER_ENABLED=true`
(keep that off in production).

LinkMart processes **vendor subscription payments only**. No endpoint prices, charges, holds or settles a
booking. Customers pay vendors directly, outside LinkMart.

---

## 1. Conventions

### Base URL and transport
- All application endpoints are under `/api`. JSON in, JSON out (`Content-Type: application/json`), except uploads (`multipart/form-data`).
- Every response carries an `X-Request-Id` header. You may send your own `X-Request-Id` (8–64 characters of `[A-Za-z0-9_-]`) to correlate logs.

### Success envelope
```json
{ "success": true, "data": <payload>, "message": "optional human text", "...": "optional extras (e.g. total, count)" }
```

### Error envelope (every failure, every endpoint)
```json
{ "success": false, "error": "Human-readable message", "code": "STABLE_CODE", "details": [ ... ], "requestId": "..." }
```
- **Branch on `code`, never on `error` text.** `details` is present for validation errors: `[{ "path": "/field", "message": "..." }]`.
- 5xx responses never contain stack traces, SQL or provider messages. Quote the `requestId` when reporting a problem.

| HTTP | Meaning | Typical `code` |
| --- | --- | --- |
| 400 | Malformed JSON body or identifier | `BAD_REQUEST`, `INVALID_INPUT`, or a Fastify `FST_ERR_*` code for body-parsing errors (treat any 400 as "fix the request") |
| 401 | Not signed in / session expired / banned | `UNAUTHENTICATED` |
| 403 | Signed in but not allowed | `FORBIDDEN`, `CUSTOMERS_ONLY`, `VENDOR_REQUIRED`, `VENDOR_SUSPENDED`, `SUBSCRIPTION_INACTIVE`, `EMAIL_NOT_VERIFIED`, `ADMIN_CANNOT_ONBOARD`, `AUTH_OPERATION_DISABLED` |
| 404 | Not found **or belongs to someone else** (no existence oracle) | `NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409 | State conflict | see section 11 |
| 422 | Validation failed | `VALIDATION_FAILED` (with `details`), `INVALID_REFERENCE` |
| 429 | Rate limited | `RATE_LIMITED` (`RateLimit-*` and `Retry-After` headers are sent) |
| 502 | Payment provider rejected or unreachable | `PAYSTACK_REJECTED`, `PAYSTACK_UNREACHABLE`, `DARAJA_REJECTED`, `DARAJA_UNREACHABLE`, `PAYMENT_INITIATION_FAILED` |
| 503 | Dependency unavailable / timeout | `PROVIDER_DISABLED`, `SERVICE_UNAVAILABLE`, `TIMEOUT`, `QUEUE_UNAVAILABLE` |

### Pagination
`?limit=` (1–100, default 20) and `?offset=` (0–10000, default 0) on list endpoints that accept them.
`GET /api/listings` also returns `total` and `count` next to `data`. Other lists return a plain array; request
`limit + 1` items if you need to know whether there is a next page.

### Dates and money
- **Calendar dates** (bookings, availability) are `YYYY-MM-DD` strings in Africa/Nairobi time. Booking ranges are inclusive.
- **Timestamps** are ISO-8601 UTC.
- **Subscription money** is an integer in minor units (`amountMinor`, KES cents) plus `currency`. Display `amountMinor / 100`.
- Listing `price`/`minPrice`/`maxPrice` are display prices set by the vendor (KES). They are informational only: nothing is charged.

### Response types that matter
| Field | Type | Example |
| --- | --- | --- |
| Listing `price`, `minPrice`, `maxPrice` | **string** (exact decimal) or `null` | `"50000.00"` |
| Listing `rating` | **number** (one decimal) or `null` until the first review | `4.5` |
| Listing `reviewCount`, `views`, `bookingsCount` | integer | `12` |
| Review `rating` | integer 1–5 | `4` |
| Review stats `average` | **number** or `null` | `4.5` |
| Subscription `amountMinor` | integer (KES cents) | `150000` |
| Timestamps | ISO-8601 string (UTC) | `"2026-11-24T09:30:00.000Z"` |
| Calendar dates | `YYYY-MM-DD` string | `"2026-12-20"` |

The listing and review response types are declared in `openapi.json` and enforced when responses are serialised.

### Authentication
Cookie-based sessions from Better Auth. Send every request with credentials (`fetch(url, { credentials: 'include' })`).
The cookie is `better-auth.session_token` (`__Secure-better-auth.session_token` in production). It is HttpOnly, so never
try to read it. Sessions last 7 days and are refreshed daily on use.

### Roles and guards (used in the tables below)
| Guard | Who passes |
| --- | --- |
| Public | anyone |
| User | any signed-in user |
| Verified | signed-in user with a verified email |
| Customer | verified user with role `customer` (vendors and admins get 403 `CUSTOMERS_ONLY`) |
| Vendor | role `vendor` with a vendor profile, **including suspended or unpaid vendors** (profile, billing, read-only views) |
| Active vendor | vendor not suspended by an admin (else 403 `VENDOR_SUSPENDED`) |
| Entitled vendor | active vendor whose subscription is `trialing`, `active` or `past_due` (else 403 `SUBSCRIPTION_INACTIVE`) |
| Admin | role `admin` |

---

## 2. Auth (Better Auth) — `/api/auth/*`

Proxied to Better Auth. The ones the frontend needs:

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/sign-up/email` | `{ email, password (≥8), name }` | Creates a **customer** and sets the session cookie. Any `role` field is ignored. A 6-digit verification code is emailed |
| POST | `/api/auth/sign-in/email` | `{ email, password }` | Sets the session cookie |
| POST | `/api/auth/sign-out` | – | Clears the session |
| GET | `/api/auth/get-session` | – | Current session and user, or `null` |
| POST | `/api/auth/sign-in/social` | `{ provider: 'google', callbackURL }` | Only if Google is configured on the server. `callbackURL` must be relative or on a trusted origin (else 403). Google returns to `{BETTER_AUTH_URL}/api/auth/callback/google` |
| POST | `/api/auth/request-password-reset` | `{ email }` | Always **200** `{ status: true, message }`, whether or not the account exists (no enumeration). Emails a link to `{FRONTEND_URL}/auth/reset-password?token=…`, valid **60 minutes**, single use. At most one email per account per 5 minutes. Rate limit 5 per 15 min per client IP |
| POST | `/api/auth/reset-password` | `{ token, newPassword (≥8) }` | 200 `{ status: true }`. Signs out every existing session. **400** with `INVALID_TOKEN` if the token is unknown, already used or expired; 400 if the password is too short. Rate limit 10 per 15 min |

Auth endpoints return Better Auth's own JSON (`{ code, message }` on errors), not the LinkMart envelope.
Rate limit: 30/min for the other auth endpoints. Requests from an `Origin` outside `CORS_ORIGINS` are refused (403).
Better Auth admin operations that would bypass LinkMart's rules are **disabled for everyone**
(403 `AUTH_OPERATION_DISABLED`): `admin/set-role`, `admin/create-user`, `admin/remove-user`, `admin/impersonate-user`,
`admin/stop-impersonating`, `admin/set-user-password`, `admin/update-user`.

### Email verification — `/api/otp`
| Method | Path | Guard | Body | Notes |
| --- | --- | --- | --- | --- |
| POST | `/api/otp/verify-email` | User | `{ otp: "123456" }` | 422 on a wrong or expired code (5 attempts per code, 20 failures per day: `OTP_DAILY_LIMIT`). 409 `ALREADY_VERIFIED` |
| POST | `/api/otp/resend-otp` | User | – | Throttled (`OTP_RESEND_TOO_SOON`, 3/min) |

---

## 3. Users — `/api/users`
| Method | Path | Guard | Request | Response `data` |
| --- | --- | --- | --- | --- |
| GET | `/me` | User | – | Profile incl. `role`, `verified`, `fullName`, `phone`, `avatarUrl` |
| PATCH | `/me` | User | `{ fullName? (2–100), phone? (Kenyan: `+2547…`/`07…`/`01…`), avatarUrl? (URL) }` | Updated profile. Unknown fields (e.g. `role`) are ignored |
| GET | `/me/saved` | Verified | – | Saved listings |
| POST | `/me/saved/:listingId` | Verified | – | **Toggles**: `{ saved: true }` or `{ saved: false }`. 404 if the listing isn't active |
| GET | `/me/saved/:listingId` | Verified | – | `{ saved: boolean }` |
| GET | `/me/stats` | Verified | – | Booking counts per status (no money fields) |

---

## 4. Vendors — `/api/vendors`
| Method | Path | Guard | Request | Notes |
| --- | --- | --- | --- | --- |
| POST | `/become` | Verified | optional `{ businessName? (3–255), phoneNumber? }` | **Instant onboarding**: creates the vendor, switches the role to `vendor`, starts the one-month free trial. 201 created / 200 already a vendor. Admins: 403 `ADMIN_CANNOT_ONBOARD`. Rate limit 5/min |
| GET | `/me` | Vendor | – | Owner view + `profileComplete`, `missing[]`, `subscription` (entitlement) |
| PUT | `/me` | Vendor | `{ businessName?, phoneNumber?, logo? (URL) }` | Slug is stable across renames |
| POST | `/me/payout-details` | Vendor | `{ payoutMethod:'mpesa', mpesaNumber }` or `{ payoutMethod:'bank', bankAccountName, bankAccountNumber, bankName }` | Private to the vendor. **LinkMart makes no payouts** (decision D9 pending); consider hiding this in the UI |
| GET | `/:vendorId` | Public | – | Public profile: `id, businessName, slug, logo, phoneNumber, verified, createdAt`. 404 if suspended or unentitled |

---

## 5. Catalog

### Listings — `/api/listings`
| Method | Path | Guard | Request | Notes |
| --- | --- | --- | --- | --- |
| GET | `/` | Public | query `categoryId, categorySlug, county, area, search (≤200), minPrice, maxPrice, vendorId, sortBy (price\|newest\|popular), limit, offset` | `data[]`, `total`, `count`. Only active listings of approved, entitled vendors |
| GET | `/featured` | Public | – | Up to 10 |
| GET | `/slug/:slug` | Public | – | |
| GET | `/me` | Vendor | – | The vendor's own listings, all statuses |
| GET | `/:id` | Public (owner sees drafts) | – | 404 for drafts, deleted listings, or hidden vendors (unless you are the owner) |
| POST | `/` | Active vendor | `{ categoryId, title (5–255), description (20–5000), location: { county, area, country?, latitude?, longitude? }, pricingType: per_hour\|per_day\|per_person\|package\|contact, price?, minPrice?, maxPrice?, currency?: 'KES', photos?: URL[], coverPhoto?: URL }` | Created as a **draft** (201) |
| PUT | `/:id` | Active vendor (owner) | same fields, all optional | |
| PATCH | `/:id/status` | Active vendor (owner) | `{ status: 'active' \| 'paused' }` | Publishing requires an entitled subscription (403 `SUBSCRIPTION_INACTIVE`) |
| DELETE | `/:id` | Vendor (owner) | – | Soft delete. 409 `LISTING_HAS_BOOKINGS` if open or upcoming bookings exist |

### Categories — `/api/categories`
| Method | Path | Guard | Request |
| --- | --- | --- | --- |
| GET | `/`, `/tree`, `/slug/:slug`, `/:id`, `/:id/subcategories` | Public | – |
| POST | `/` | Admin | `{ name (2–100), slug? (a-z0-9-), icon?, imageUrl?, parentId? }` (201; 409 `SLUG_TAKEN`) |
| PUT | `/:id` | Admin | same, optional |
| DELETE | `/:id` | Admin | 409 `CATEGORY_HAS_CHILDREN` / `CATEGORY_IN_USE` |

---

## 6. Availability — `/api/listings/:listingId/...`
| Method | Path | Guard | Request | Notes |
| --- | --- | --- | --- | --- |
| GET | `/availability` | Public | query `startDate, endDate` (YYYY-MM-DD) | `{ available: boolean, listingId, startDate, endDate }` |
| GET | `/calendar` | Public | query `startDate, endDate` | Unavailable dates. Vendors' private block reasons are shown as `Unavailable` |
| POST | `/block` | Active vendor (owner) | `{ dates: YYYY-MM-DD[] (1–366), reason? }` | 409 `DATES_BOOKED` if a date has an accepted booking |
| POST | `/unblock` | Active vendor (owner) | `{ dates: [...] }` | |

Only **accepted** bookings and vendor blocks make dates unavailable. Pending requests do not hold dates (D10).

---

## 7. Bookings (request-to-book) — `/api/bookings`

Lifecycle: `requested → accepted | declined | expired | cancelled`, then `accepted → completed | cancelled`.
The vendor has **24 hours** (`respondBy`) to accept or decline. After that the request expires automatically.

| Method | Path | Guard | Request | Notes |
| --- | --- | --- | --- | --- |
| POST | `/` | Customer | `{ listingId, startDate, endDate, guests (1–10000), specialRequests? (≤1000) }` | 201 with the booking (`status: 'requested'`, `respondBy`). Rate limit 10/min. Errors: `DATES_UNAVAILABLE`, `DUPLICATE_REQUEST`, `TOO_MANY_OPEN_REQUESTS` (5 open max), `OWN_LISTING`, 404 if the listing isn't bookable |
| GET | `/me` | User | query `status?, limit, offset` | Customer's bookings |
| GET | `/vendor` | Vendor | query `status?, limit, offset` | Vendor's incoming bookings |
| GET | `/vendor/pending` | Vendor | – | Open requests, soonest deadline first |
| GET | `/:id` | Party (customer, owning vendor) or admin | – | Full booking view (below). Others: 404 |
| GET | `/:id/events` | Party or admin | – | Transition history |
| PUT | `/:id/accept` | Entitled vendor (owner) | – | 409 `REQUEST_EXPIRED` (deadline passed; the request is expired), `DATES_UNAVAILABLE`, `INVALID_TRANSITION`. Opens the conversation and declines overlapping requests |
| PUT | `/:id/decline` | Vendor (owner) | `{ reason (10–500) }` | Allowed even when unpaid or suspended |
| PUT | `/:id/cancel` | Customer (requested/accepted) or vendor (accepted) | `{ reason (10–500) }` | Before the start date only (`BOOKING_STARTED`) |

`status` filter values: `requested, accepted, declined, expired, cancelled, completed`. The legacy aliases
`pending` (→ requested) and `confirmed` (→ accepted) are accepted as filters only.

**Booking view** (`GET /:id`, create, accept, …):
```json
{
  "id": "…", "status": "accepted", "startDate": "2026-12-20", "endDate": "2026-12-21", "guests": 50,
  "specialRequests": null, "pricingType": "per_day", "currency": "KES",
  "respondBy": null,
  "declineReason": null, "cancellationReason": null, "cancelledBy": null,
  "acceptedAt": "…", "declinedAt": null, "expiredAt": null, "cancelledAt": null, "completedAt": null, "createdAt": "…",
  "listing": { "id": "…", "title": "…", "slug": "…", "coverPhoto": "…", "location": { "county": "…", "area": "…" } },
  "customer": { "id": "…", "fullName": "…", "email": "only to the vendor, once accepted", "phone": "only to the vendor, once accepted" },
  "vendor": { "id": "…", "businessName": "…", "slug": "…", "logo": "…", "phoneNumber": "only once accepted" },
  "paymentNote": "Payment for this service is arranged directly between the customer and the vendor. LinkMart does not process it."
}
```
There are no amount, fee, VAT or payment-status fields on bookings.

---

## 8. Messaging — `/api/conversations`, `/api/messages`

A conversation exists only after the vendor **accepts** a booking. It is writable while the booking is accepted and
for 30 days after completion, and read-only after cancellation. Polling-based (no websockets).

| Method | Path | Guard | Request | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/conversations` | User | – | My conversations |
| GET | `/api/conversations/by-booking/:bookingId` | User (party) | – | 404 before acceptance |
| GET | `/api/conversations/:id/messages` | User (party) or admin | query `after?` (ISO timestamp, for polling), `limit` (1–200, default 100) | Hidden messages are omitted |
| POST | `/api/conversations/:id/messages` | User (party) | `{ body (1–2000) }` | 201. 409 `CONVERSATION_CLOSED`. Rate limit 20/min. Admins can read but not post |
| POST | `/api/messages/:id/report` | User (party) | `{ reason (5–500) }` | Can't report your own message (`OWN_MESSAGE`) |

---

## 9. Reviews — `/api/reviews`
| Method | Path | Guard | Request | Notes |
| --- | --- | --- | --- | --- |
| POST | `/` | Customer | `{ bookingId, rating (1–5), title? (≤120), body (10–2000) }` | 201. Only the customer of a **completed** booking (else 404). 409 `ALREADY_REVIEWED` |
| GET | `/listing/:listingId` | Public | `limit, offset` | Visible reviews |
| GET | `/eligibility/:listingId` | Verified | – | Whether the caller can review |
| POST | `/:reviewId/reply` | Vendor (owner) | `{ reply (5–1000) }` | 409 `ALREADY_REPLIED` |
| PATCH | `/:reviewId/visibility` | Admin | `{ isVisible }` | |

---

## 10. Uploads — `/api/upload`
| Method | Path | Guard | Request | Notes |
| --- | --- | --- | --- | --- |
| POST | `/image` | User | multipart: field `uploadType` **first**, then one file part. `uploadType` ∈ `listing_photo, vendor_logo, profile_photo` | 201 `{ id, url, publicId, bytes, mimeType: 'image/webp', width, height }`. `listing_photo` and `vendor_logo` are vendor-only (403 `VENDOR_REQUIRED`). Type is detected from the bytes (JPEG, PNG, WebP); max `MAX_FILE_SIZE` (5 MB default). Rate limit 30/min |
| POST | `/images` | User | same, up to 10 files | 201 array. Rate limit 10/min |
| DELETE | `/file` | User (owner) or admin | `{ publicId }` | 404 if not yours |

**Multipart field order is required.** Files are processed as they stream in, so `uploadType` must be
appended to the `FormData` before the file(s):
```js
const form = new FormData();
form.append('uploadType', 'profile_photo'); // first
form.append('file', file);                  // then the file(s)
```
If `uploadType` is missing, invalid, or arrives after a file, the request fails with **422 `VALIDATION_FAILED`**
(`details: [{ path: '/uploadType', … }]`) and nothing is stored.

---

## 11. Subscriptions (vendors) — `/api/subscriptions`

States: `trialing` (one month free) → `past_due` (invoice issued; grace period) → `active` when paid.
Unpaid after grace → `suspended` → `expired`. `cancelled` at period end on request. **Entitled** (listings visible,
can publish and accept) = `trialing`, `active`, `past_due`. Vendors created before subscriptions existed report
`legacy_unenrolled` and are entitled until an admin enrols them (decision D3).

| Method | Path | Guard | Request | Notes |
| --- | --- | --- | --- | --- |
| GET | `/payment-methods` | Public | – | `{ paystack, mpesa, paystackRecurring, mpesaRecurring: false }` (which methods are switched on) |
| GET | `/me` | Vendor | – | `{ status, entitled, subscription: { trialEndsAt, currentPeriodEnd, graceEndsAt, cancelAtPeriodEnd, billingHoldReason, … }, openInvoice, currentPlan: { name, amountMinor, currency, interval } \| null }` |
| GET | `/me/invoices` | Vendor | `limit, offset` | |
| GET | `/me/payments` | Vendor | `limit, offset` | Payment attempts (no card or phone details beyond a masked number) |
| POST | `/me/payments` | Vendor | `{ provider: 'paystack' }` or `{ provider: 'mpesa', phone }`; header `Idempotency-Key` (recommended, 8–100 chars) | **202** with a payment attempt (below). Rate limit 5/min. 409 `NO_PAYMENT_DUE`, `NO_ACTIVE_PLAN`, `SUBSCRIPTION_NOT_ENROLLED`, `IDEMPOTENCY_KEY_REUSED`, `AMOUNT_NOT_SUPPORTED`; 503 `PROVIDER_DISABLED`; 502 on provider rejection |
| GET | `/me/payments/:id` | Vendor (own) | – | Poll this. Pending attempts are re-verified with the provider server-side |
| POST | `/me/cancel` | Vendor | – | Trialing/active: at period end. Past-due/suspended: immediately. 409 `SUBSCRIPTION_NOT_CANCELLABLE` |
| POST | `/me/resume` | Vendor | – | Undo a scheduled cancellation. 409 `NOTHING_TO_RESUME` |
| PATCH | `/me/auto-renew` | Vendor | `{ enabled }` | Saved-card renewal. **Disabled until approved** (409 `RECURRING_NOT_AVAILABLE`) |

**Payment attempt:**
```json
{ "id": "…", "provider": "paystack|mpesa", "status": "initiated|pending|succeeded|failed|cancelled|reversed",
  "amountMinor": 150000, "currency": "KES", "checkoutUrl": "https://checkout.paystack.com/… (pending card payments only)",
  "reference": "…", "receipt": "M-Pesa receipt or Paystack transaction id", "phone": "254******678",
  "failureReason": "…", "message": "provider message to show (M-Pesa)", "createdAt": "…", "completedAt": "…" }
```
A payment counts only after LinkMart verifies it with the provider. Never treat a Paystack redirect or an M-Pesa
"success" screen as proof: poll `GET /me/payments/:id` (and `GET /me`) until `succeeded`, `failed` or `cancelled`.

---

## 12. Payment provider webhooks — `/api/payments` (server-to-server, not for the frontend)
| Method | Path | Authentication |
| --- | --- | --- |
| POST | `/api/payments/paystack/webhook` | `x-paystack-signature` HMAC-SHA512 over the raw body. 401 `INVALID_SIGNATURE` otherwise. Handles `charge.success`, `refund.processed`, `charge.dispute.*`; others are stored only |
| POST | `/api/payments/daraja/callback/:token` | Secret path token (`DARAJA_CALLBACK_TOKEN`) + optional IP allow-list. Unknown token: 404. Replies `{ ResultCode: 0, ResultDesc: 'Accepted' }` |

---

## 13. Administration — `/api/admin/*` (Admin guard on everything)

### Vendors — `/api/admin/vendors`
| Method | Path | Request | Notes |
| --- | --- | --- | --- |
| GET | `/` | `status? (approved\|suspended), limit, offset` | Includes account email and name |
| GET | `/:vendorId` | – | Vendor + entitlement. **Payout details are not returned** (`hasPayoutDetails` only) |
| PUT | `/:vendorId/suspend` | `{ reason? (5–500) }` | Moderation. Independent of the subscription. Audited. 409 `NO_CHANGE` |
| PUT | `/:vendorId/reinstate` | `{ reason? }` | Audited |

### Customers — `/api/admin/customers`
`GET /` with `page?, limit (≤100, default 50), offset?`.

### Bookings — `/api/admin/bookings`
`GET /` (`status?, limit, offset`) and `GET /:id` (includes transition events). Read-only.

### Messaging moderation — `/api/admin/messages`
`GET /reports` (open reports); `POST /:id/moderate` `{ action: 'hide' | 'dismiss' }` (audited).

### Subscriptions — `/api/admin/subscriptions`
| Method | Path | Request | Notes |
| --- | --- | --- | --- |
| GET | `/` | `status?, limit, offset` | |
| GET | `/vendors/:vendorId` | – | Investigation view: subscription (no stored card authorization; `hasSavedCard`), last 24 invoices, last 50 payments, audit trail |
| GET | `/plans` | – | All plans (price history) |
| POST | `/plans` | `{ code (a-z0-9_-), name, amountMinor (whole shillings, >0), currency: 'KES', activate? }` | **The only way a price is set.** Activating replaces the previous plan; issued invoices keep their amount |
| PATCH | `/plans/:id` | `{ active }` | |
| GET | `/unenrolled` | – | Vendors with no subscription (awaiting D3) |
| POST | `/unenrolled/:vendorId/enrol` | – | Starts a trial now. Deliberate, per vendor. 409 `SUBSCRIPTION_EXISTS` |
| GET | `/revenue` | `from, to` (dates, required) | Sums of the append-only revenue journal by currency and entry type (`subscription_payment`, `refund`, `reversal`), with `needsReview` counts |

### Payments (investigation only) — `/api/admin/payments`
| Method | Path | Request | Notes |
| --- | --- | --- | --- |
| GET | `/` | `status?, provider? (paystack\|mpesa), vendorId?, needsReview? (true), limit, offset` | Includes `requiresReview`, `reviewReason`, `reviewedAt` |
| GET | `/provider-events` | `state? (unmatched\|unprocessed), provider?, limit, offset` | Stored webhooks/callbacks (sanitised: no card authorization codes, masked phone numbers) |
| GET | `/:id` | – | Attempt, invoice, provider events, revenue entries, audit trail |
| POST | `/:id/review` | `{ note (5–2000) }` | Closes the review flag. Never moves money or changes access. 409 `NO_OPEN_REVIEW` |
| POST | `/:id/reverify` | – | Asks the provider again and applies only the provider's answer. Rate limit 10/min. 409 `NOT_VERIFIABLE` |

Review reasons: `amount_or_currency_mismatch`, `reference_mismatch`, `paid_settled_invoice`, `provider_reversal`,
`provider_partial_refund`, `additional_reversal_not_journaled`, `reversal_of_uncredited_payment`,
`reversal_currency_mismatch`, `provider_dispute`.

### Operations — `/api/admin/operations`
| Method | Path | Request | Notes |
| --- | --- | --- | --- |
| GET | `/health` | – | DB/Redis status, queue counts, live workers (`alive`), outbox backlog and dead letters, payment review counts |
| GET | `/queues/:queue/failed` | `queue ∈ bookings, scheduler`; `limit, offset` | Failed jobs (kept 7 days) |
| POST | `/queues/:queue/jobs/:jobId/retry` | – | Failed jobs only (409 `INVALID_TRANSITION`). Audited |
| GET | `/outbox` | `state (failed\|pending\|retrying, default failed), topic?, limit, offset` | Notification delivery status |
| POST | `/outbox/:id/retry` | – | Re-queue a dead-lettered notification (emails already sent are not repeated). Audited |
| GET | `/audit` | `entityType?, entityId?, action?, actorUserId?, from?, to?, limit, offset` | Append-only audit log |

---

## 14. Health
`GET /health` (liveness, always 200 while the process runs) and `GET /ready` (`{ status, database, redis }`; 503 when the
database is unreachable; Redis down is reported but not fatal).

## 15. Rate limits
**Who is counted:**
- A request with a **valid session** is counted against **that account**, wherever it comes from. Users behind the
  same proxy or network have independent limits.
- A request **without a valid session** (sign-in, sign-up, password reset, public browsing, or an expired or forged
  cookie) is counted against the **client IP**. Behind the frontend's `/api` proxy the client IP comes from
  `X-Forwarded-For`, believed only from proxies allowed by the server's `TRUST_PROXY` setting. Otherwise it's the
  connecting address.

**Limits (per account or per client IP, per window):** global 300/min; sign-in, sign-up and other auth 30/min;
password-reset request 5 per 15 min; password reset 10 per 15 min; OTP verify 10/min; OTP resend 3/min; vendor
onboarding 5/min; booking requests 10/min; subscription payment starts 5/min; messages 20/min; uploads 30/min
(single) or 10/min (multiple); admin re-verify 10/min. Webhooks: 300/min. `/health` and `/ready` are not limited.

A route with its own limit counts only against that limit; all other routes share the global 300/min. Exceeding a limit returns **429 `RATE_LIMITED`** with
`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` and `Retry-After` headers. In production Better Auth also
applies its own short-window limits to sign-in, sign-up and password-reset requests (3 per 10 s and 3 per 60 s per IP).
