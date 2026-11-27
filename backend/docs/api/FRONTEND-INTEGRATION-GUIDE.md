# Frontend integration guide (LinkMart backend v2)

For the team building the LinkMart web frontend against the refactored backend. Endpoint-level detail is in
[API-REFERENCE.md](./API-REFERENCE.md); the generated schema is [openapi.json](./openapi.json). Breaking changes
from the previous backend are listed at the end of this guide.

**Ground rule:** LinkMart never handles money for bookings. The UI must not show booking checkout, payment buttons,
fees, VAT or "payment pending" states for bookings. The only payments in the product are vendor subscription
payments (card via Paystack, or M-Pesa STK Push).

---

## 1. Authentication and session handling

- Sessions are **HttpOnly cookies** set by Better Auth. Send every API request with credentials
  (`fetch(url, { credentials: 'include' })`, or `withCredentials: true` in axios). Never store tokens in `localStorage`.
- **Deployment model: same-origin `/api` proxy.** The frontend serves `/api/*` on its own origin and proxies it to the
  API (Next.js rewrite). Cookies are then first-party for the frontend, whatever domain the API runs on. Point the Better
  Auth client at the frontend origin (`baseURL: window.location.origin`, `basePath: '/api/auth'`). The backend must be
  configured with `BETTER_AUTH_URL` = the frontend origin, listed in `CORS_ORIGINS`; the Google redirect URI is
  `{frontend origin}/api/auth/callback/google`. See the backend runbook.
- Only use `callbackURL`/`redirectTo` values that are relative paths (e.g. `/store`) or on the frontend origin; others
  are refused (403).
- Server-side fetches from Next.js should forward the visitor's cookie. Anonymous server-side fetches are rate-limited
  as the Next server's IP (300/min shared), so cache public pages where you can.
- Sign up: `POST /api/auth/sign-up/email { email, password, name }`. The account is always a **customer**, and a
  6-digit code is emailed. Show an "enter your code" screen and call `POST /api/otp/verify-email { otp }`.
  Resend with `POST /api/otp/resend-otp` (throttled; on `OTP_RESEND_TOO_SOON` show a countdown).
- Sign in / out: `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out`.
- **Forgot password:**
  1. `POST /api/auth/request-password-reset { email }` always returns 200, so show "If an account exists, we've emailed
     a link" whatever happens.
  2. The email links to **`/auth/reset-password?token=…`** on the frontend (build this page). It posts
     `POST /api/auth/reset-password { token, newPassword }`. On 400 `INVALID_TOKEN` (used, expired after 60 minutes, or
     unknown), offer to request a new link.
  3. A successful reset signs the user out everywhere; send them to sign-in.
- **Vendor sign-up order:** `POST /api/vendors/become` requires a verified email (403 `EMAIL_NOT_VERIFIED`). Create the
  account, verify the code, then call `become`.
- Current user: `GET /api/users/me` (has `role` and `verified`). Use it on app load; a 401 means "signed out".
- Booking, saving listings, reviews and becoming a vendor require a **verified email**. On 403 `EMAIL_NOT_VERIFIED`,
  route the user to the verification screen.
- Roles: `customer`, `vendor`, `admin`. Use the role to choose the UI, but never as security: the server enforces it.

## 2. Customer workflows

1. **Browse**: `GET /api/listings` (filters `categorySlug`, `county`, `area`, `search`, `minPrice`, `maxPrice`, `sortBy`;
   paginate with `limit`/`offset`; `total` drives the pager). Categories: `GET /api/categories/tree`.
2. **Listing page**: `GET /api/listings/slug/:slug`, vendor `GET /api/vendors/:vendorId`, reviews
   `GET /api/reviews/listing/:listingId`, availability calendar `GET /api/listings/:id/calendar?startDate=&endDate=`.
3. **Request to book**: `POST /api/bookings { listingId, startDate, endDate, guests, specialRequests? }`. Show
   "Request sent. The vendor has until {respondBy} to respond." There is no payment step.
4. **My bookings**: `GET /api/bookings/me?status=`. Show status chips for `requested`, `accepted`, `declined`,
   `expired`, `cancelled` and `completed`.
5. **After acceptance**: the booking now includes the vendor's phone number, and a conversation exists. Show
   `paymentNote` ("arranged directly between the customer and the vendor").
6. **Cancel**: `PUT /api/bookings/:id/cancel { reason }` (≥10 characters), before the start date.
7. **Review**: once `completed`, `GET /api/reviews/eligibility/:listingId`, then `POST /api/reviews`.
8. **Saved listings**: `POST /api/users/me/saved/:listingId` toggles and returns `{ saved }`.

## 3. Vendor onboarding

- Any verified customer can become a vendor instantly: `POST /api/vendors/become { businessName?, phoneNumber? }`
  returns 201 (created) or 200 (already a vendor). **Re-fetch `/api/users/me` afterwards**: the role is now `vendor`.
- The one-month free trial starts immediately. Show the trial end date from `GET /api/subscriptions/me` →
  `subscription.trialEndsAt`.
- A vendor account can't make bookings (403 `CUSTOMERS_ONLY`). If you offer "book as a customer" to vendors,
  explain that they need a separate customer account.
- Admin accounts can't onboard (403 `ADMIN_CANNOT_ONBOARD`).

## 4. Vendor profile management

- `GET /api/vendors/me` returns the profile, `profileComplete`, `missing[]` (e.g. `logo`, `phone number`) and
  `subscription` (the entitlement). Use `missing` to prompt for completion.
- `PUT /api/vendors/me { businessName?, logo?, businessEmail?, phoneNumber?, whatsappNumber? }`. Upload the logo first
  with `POST /api/upload/image` (`uploadType=vendor_logo`) and send the returned `url`.
- **Business contact** (business email, phone, WhatsApp) lives on the vendor profile and is shown publicly on every
  listing (`listing.vendor.businessEmail / phoneNumber / whatsappNumber`). It is separate from the login email. Send
  `null` or `""` to clear a field; numbers come back in E.164 (`+254712345678`). `GET /api/vendors/me` returns
  `contactMissing[]` with the fields still needed to publish.
- Payout details (`POST /api/vendors/me/payout-details`) exist but **LinkMart does not pay vendors**. Hide this
  screen unless the product decides otherwise (decision D9).
- If an admin suspends the vendor, mutating vendor actions return 403 `VENDOR_SUSPENDED`. Show a banner; billing
  and existing bookings stay reachable.

## 5. Listing management

- Create as a draft: `POST /api/listings` (category, title, description, location, `pricingType`, optional display
  prices, photos). Upload photos first (`POST /api/upload/images`, `uploadType=listing_photo`, put the `uploadType`
  field **before** the files in the form data).
- Publish or pause: `PATCH /api/listings/:id/status { status: 'active' | 'paused' }`. Publishing requires an entitled
  subscription (on 403 `SUBSCRIPTION_INACTIVE`, link to billing) and a complete business contact (on 422
  `BUSINESS_CONTACT_REQUIRED`, `details.missing` names the fields; link to the business profile, then retry).
- Edit: `PUT /api/listings/:id`. The slug never changes, so shared links keep working.
- Delete: `DELETE /api/listings/:id`. 409 `LISTING_HAS_BOOKINGS` means open or upcoming bookings exist.
- Own listings (all statuses): `GET /api/listings/me`.
- Prices on listings are for display only ("from KES 50,000 per day"). `pricingType: 'contact'` means "contact for price".
- Types: `price`, `minPrice` and `maxPrice` are **strings** (`"50000.00"`, or `null`); parse them for display.
  `rating` is a **number** (`4.5`) or `null`. Review stats `average` is a number or `null`.
- **Uploads:** append `uploadType` to the `FormData` **before** the file(s). A missing or late `uploadType` returns 422
  and nothing is stored. This applies to profile photos (`profile_photo`) as well as vendor images.

## 6. Subscription management

- `GET /api/subscriptions/me` drives the billing page:
  - `status`: `trialing | active | past_due | suspended | cancelled | expired | legacy_unenrolled`
  - `entitled`: whether listings are visible and the vendor can publish or accept
  - `subscription.trialEndsAt`, `currentPeriodEnd`, `graceEndsAt`, `cancelAtPeriodEnd`, `billingHoldReason`
  - `openInvoice` (amount due), `currentPlan` (the price; **may be `null`** while no price has been configured)
- Suggested banners:

  | Status | Banner |
  | --- | --- |
  | `trialing` | "Free trial until {trialEndsAt}" |
  | `past_due` | "Payment due. Pay by {graceEndsAt} to keep your listings visible" |
  | `suspended` | "Listings hidden. Pay {openInvoice.amountMinor/100} to restore" |
  | `expired` / `cancelled` | "Resubscribe" (paying issues a fresh invoice) |
  | `legacy_unenrolled` | Nothing to pay yet |

- `billingHoldReason: 'no_active_plan'` means no price is set yet. Don't show a payment button. `currentPlan` is `null`.
- History: `GET /api/subscriptions/me/invoices` and `/me/payments`.
- Cancel: `POST /api/subscriptions/me/cancel` (takes effect at period end when trialing or active). Undo with
  `POST /api/subscriptions/me/resume`.
- Automatic card renewal (`PATCH /api/subscriptions/me/auto-renew`) is **switched off** pending approval. Hide the toggle
  unless `GET /api/subscriptions/payment-methods` returns `paystackRecurring: true`.

## 7. Subscription payment initiation

Check `GET /api/subscriptions/payment-methods` first, and only show the methods that are `true`.

**Card (Paystack)**
1. `POST /api/subscriptions/me/payments { provider: 'paystack' }` with header `Idempotency-Key: <uuid>`. Generate
   the key once per click and reuse it if you retry.
2. Response 202: redirect the browser to `data.checkoutUrl`.
3. Paystack sends the vendor back to the configured callback page. **Don't trust the redirect.** Poll
   `GET /api/subscriptions/me/payments/:id` every 2–3 seconds (up to about 2 minutes) until `status` is
   `succeeded`, `failed` or `cancelled`. Then re-fetch `GET /api/subscriptions/me`.

**M-Pesa (STK Push)**
1. `POST /api/subscriptions/me/payments { provider: 'mpesa', phone: '07XXXXXXXX' }` with an `Idempotency-Key`.
2. Show "Check your phone and enter your M-Pesa PIN" (`data.message` has Safaricom's text, and `data.phone` the masked number).
3. Poll `GET /api/subscriptions/me/payments/:id` until it's final. `cancelled` usually means the vendor dismissed the prompt.
   Offer "Try again", which creates a new attempt.
4. There is **no automatic monthly M-Pesa deduction**. Each month the vendor starts a payment and approves it on the phone.

**Errors**: `NO_PAYMENT_DUE` (hide the button), `NO_ACTIVE_PLAN`, `PROVIDER_DISABLED`, `IDEMPOTENCY_KEY_REUSED`
(use a new key), 502 (provider problem: "Please try again shortly"), 429 (slow down).

## 8. Booking request lifecycle

```
requested ──accept──▶ accepted ──(end date + 2 days)──▶ completed
    │                    │
    ├─decline─▶ declined ├─cancel─▶ cancelled
    ├─cancel──▶ cancelled
    └─24h no response──▶ expired
```
- `respondBy` (on `requested` only) is the vendor's deadline. Show a countdown to both parties.
- Expiry is automatic. If a vendor tries to accept late they get 409 `REQUEST_EXPIRED`, and the booking is then `expired`.
- Pending requests **don't hold dates**. Accepting one declines any other overlapping requests automatically
  (reason "Dates no longer available").
- History for a timeline view: `GET /api/bookings/:id/events`.

## 9. Vendor booking management

- Inbox: `GET /api/bookings/vendor/pending` (soonest deadline first) and `GET /api/bookings/vendor?status=`.
- Accept: `PUT /api/bookings/:id/accept`. Handle 409 `REQUEST_EXPIRED` ("This request expired"), 409
  `DATES_UNAVAILABLE` ("Those dates were just booked") and 403 `SUBSCRIPTION_INACTIVE` (link to billing).
- Decline: `PUT /api/bookings/:id/decline { reason }` (≥10 characters). This works even when billing lapses.
- Cancel an accepted booking: `PUT /api/bookings/:id/cancel { reason }`.
- Customer contact details (email, phone) appear on the booking **only after acceptance**.

## 10. Availability management

- Vendor calendar: `GET /api/listings/:id/calendar?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`.
- Block or unblock dates: `POST /api/listings/:id/block { dates: [...], reason? }` and `/unblock { dates }`.
  409 `DATES_BOOKED` means a date has an accepted booking.
- Public pages see blocked dates as `Unavailable`; the reason stays private.
- Quick check before submitting a request: `GET /api/listings/:id/availability?startDate=&endDate=` → `{ available }`.

## 11. Customer–vendor communication

- A conversation exists once a booking is **accepted**: `GET /api/conversations/by-booking/:bookingId` (404 before).
- Inbox: `GET /api/conversations`.
- Thread: `GET /api/conversations/:id/messages`. Poll with `?after=<createdAt of the last message>` every 5–10 seconds
  while the thread is open. There are no websockets.
- Send: `POST /api/conversations/:id/messages { body }` (1–2000 characters, 20/min). On 409 `CONVERSATION_CLOSED`
  (booking cancelled, or more than 30 days after completion), make the thread read-only.
- Report: `POST /api/messages/:id/report { reason }`.
- Admins can read but not post.

## 12. Notifications

- Notifications are **email only** (sent by the backend worker through the outbox). There is no in-app notification
  endpoint. Show in-app state by polling the relevant resources (pending bookings, subscription status, unread
  conversations via `lastMessageAt`).
- Emails sent: booking requested (vendor), accepted, declined, expired (both parties), cancelled, new message,
  trial ending (7, 3 and 1 days before), payment due, payment succeeded, payment failed, subscription suspended,
  subscription expired.
- Email links point at these `FRONTEND_URL` paths, so the frontend must serve them: `/auth/reset-password?token=…`
  (password reset), `/vendor/subscription` (billing),
  `/vendor/bookings/:bookingId`, `/customer/bookings/:bookingId` and `/messages/:conversationId`
  (defined in `src/platform/mailer/templates.ts`).

## 13. Error handling

- Every error is `{ success: false, error, code, details?, requestId }`. Map `code` to UX; show `error` only as a fallback.
- `401` → signed out (redirect to sign-in, keep the return path). `403` → see `code` (`EMAIL_NOT_VERIFIED`,
  `CUSTOMERS_ONLY`, `VENDOR_SUSPENDED`, `SUBSCRIPTION_INACTIVE`, …). `404` also means "not yours": show "not found".
- `422 VALIDATION_FAILED` → `details[].path` (e.g. `/startDate`) maps to form fields.
- `409` → state changed under the user. Re-fetch the resource and show the new state.
- `429` → back off using `Retry-After`. `5xx` → generic message with the `requestId` ("Reference: …").

---

## Breaking changes from the previous backend

| Area | Before | Now |
| --- | --- | --- |
| Booking statuses | `pending`, `confirmed`, payment states | `requested`, `accepted`, `declined`, `expired`, `cancelled`, `completed`. Old names work as list filters only |
| Booking money | amounts, fees, VAT, payment-after-acceptance | **Removed.** Bookings have `pricingType`, `currency` and `paymentNote` only |
| Who can book | any signed-in user | verified **customers** only (`CUSTOMERS_ONLY`, `EMAIL_NOT_VERIFIED`) |
| Vendor onboarding | admin approval | instant (`POST /api/vendors/become`), one-month trial |
| Errors | mixed shapes, 400 for validation | one envelope with `code`; validation is **422** with `details` |
| Contact details | always visible | shared only after acceptance |
| Payouts | `/api/payouts/*`, `/api/admin/payouts/*` | **Removed** |
| Dev endpoints | `/api/dev/seed-admin` | **Removed** |
| Documents | `POST /api/upload/document` | **Removed** (no KYC uploads) |
| Uploads | any user could delete any file; upload type optional | owner or admin only. `uploadType` **required and must come before the file** (422 otherwise). Images returned as WebP |
| Listing `rating` | decimal string (`"4.5"`) | number (`4.5`) or `null` |
| Password reset | not available | `request-password-reset` + `reset-password`; frontend page `/auth/reset-password?token=` |
| Rate limits | effectively per IP | per account when signed in; per client IP otherwise |
| User stats | included `spent` | `spent` removed |
| Listing search | items only | `total` and `count` added |
| Slugs | changed on rename | stable |
| Calendar | showed block reasons | shows `Unavailable` |
| New | – | subscriptions, subscription payments, messaging, booking events, admin payments, operations and audit endpoints |
| Admin vendor view | included payout details | `hasPayoutDetails` flag only |
