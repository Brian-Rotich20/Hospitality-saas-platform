// src/utils/email.ts
// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT SWITCH — change this one import to swap email providers:
//   Nodemailer (Gmail)  →  './email.nodemailer'   ← current
//   Resend              →  './email.resend'        ← when you have a domain
// ─────────────────────────────────────────────────────────────────────────────
export {
  sendVendorVerificationEmail,
  sendVendorApprovedEmail,
  sendVendorRejectedEmail,
  sendBookingConfirmationEmail,
  sendNewBookingNotificationEmail,
} from './email.nodemailer';