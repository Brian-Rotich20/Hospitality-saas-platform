// src/utils/email.ts
// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT SWITCH — change this one import to swap providers:
//   Nodemailer (Gmail)  →  './email.nodemailer'   ← current
//   Resend              →  './email.resend'        ← when you have a domain
// ─────────────────────────────────────────────────────────────────────────────
export {
  sendCustomerVerificationEmail,
  sendVendorVerificationEmail,
  sendVendorApprovedEmail,
  sendVendorRejectedEmail,
  sendBookingConfirmationEmail,
  sendNewBookingNotificationEmail,
} from './email.brevo';