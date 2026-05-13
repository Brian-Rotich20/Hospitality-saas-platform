// src/utils/email.nodemailer.ts
// Nodemailer transport using Gmail App Password.
// Keeps identical function signatures to the Resend version
// so email.ts is the only file that changes when you switch.

import nodemailer from 'nodemailer';

// ── Transport (singleton) ──────────────────────────────────────────────────────
// Gmail requires:
//   1. 2-Step Verification enabled on the account
//   2. An App Password generated at myaccount.google.com/apppasswords
//   Set EMAIL_USER and EMAIL_PASS in your .env

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,   // e.g. ralphrotich@gmail.com
    pass: process.env.EMAIL_PASS,   // 16-char app password (spaces OK, nodemailer strips them)
  },
});

const FROM      = process.env.EMAIL_FROM_NAME
  ? `${process.env.EMAIL_FROM_NAME} <${process.env.EMAIL_USER}>`
  : `LinkMart <${process.env.EMAIL_USER}>`;

const APP_URL   = process.env.FRONTEND_URL ?? 'http://localhost:3000';

// ── Helper: send one email ─────────────────────────────────────────────────────
async function send(to: string, subject: string, html: string) {
  return transporter.sendMail({ from: FROM, to, subject, html });
}

// ── Shared HTML shell ──────────────────────────────────────────────────────────
function shell(body: string) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:'DM Sans',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0"
        style="background:#fff;border-radius:16px;border:1px solid #E5E7EB;overflow:hidden;">

        <!-- Header -->
        <tr>
          <td style="background:#2D3B45;padding:28px 32px;">
            <p style="margin:0;font-size:20px;font-weight:900;color:#F5C842;letter-spacing:-0.03em;">LinkMart</p>
            <p style="margin:4px 0 0;font-size:11px;color:#ffffff80;text-transform:uppercase;letter-spacing:0.1em;">Vendor Portal</p>
          </td>
        </tr>

        <!-- Body -->
        <tr><td style="padding:32px;">${body}</td></tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #F3F4F6;background:#F9FAFB;">
            <p style="margin:0;font-size:11px;color:#9CA3AF;text-align:center;">
              © ${new Date().getFullYear()} LinkMart · Kenya's Hospitality Marketplace
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Send vendor email verification OTP ────────────────────────────────────────
export async function sendVendorVerificationEmail(opts: {
  to:           string;
  businessName: string | undefined;
  otp:          string;
}) {
  const html = shell(`
    <p style="margin:0 0 8px;font-size:22px;font-weight:900;color:#111827;">Verify your email</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6B7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${opts.businessName ?? 'there'}</strong>, thanks for applying
      as a vendor on LinkMart. Use the code below to verify your email address.
    </p>

    <!-- OTP box -->
    <div style="background:#F8FAFC;border:2px dashed #E5E7EB;border-radius:12px;
      padding:24px;text-align:center;margin-bottom:24px;">
      <p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#9CA3AF;
        text-transform:uppercase;letter-spacing:0.1em;">Your verification code</p>
      <p style="margin:0;font-size:42px;font-weight:900;color:#2D3B45;
        letter-spacing:0.2em;">${opts.otp}</p>
      <p style="margin:8px 0 0;font-size:11px;color:#9CA3AF;">
        Expires in <strong>15 minutes</strong>
      </p>
    </div>

    <p style="margin:0 0 24px;font-size:13px;color:#6B7280;line-height:1.6;">
      Once verified, your vendor account will be
      <strong style="color:#059669;">instantly activated</strong>
      and you can start creating listings.
    </p>
    <p style="margin:0;font-size:12px;color:#9CA3AF;">
      If you didn't request this, you can safely ignore this email.
    </p>
  `);

  return send(
    opts.to,
    `${opts.otp} — Verify your LinkMart vendor account`,
    html,
  );
}

// ── Send vendor approval notification ─────────────────────────────────────────
export async function sendVendorApprovedEmail(opts: {
  to:           string;
  businessName: string | undefined;
}) {
  const html = shell(`
    <p style="margin:0 0 8px;font-size:22px;font-weight:900;color:#111827;">You're approved! 🎉</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6B7280;line-height:1.6;">
      Congratulations <strong style="color:#111827;">${opts.businessName ?? 'there'}</strong>!
      Your vendor account has been approved. You can now create and publish listings.
    </p>
    <a href="${APP_URL}/vendor/dashboard"
      style="display:inline-block;background:#2D3B45;color:#fff;
        font-weight:700;font-size:13px;padding:12px 24px;
        border-radius:10px;text-decoration:none;">
      Go to Dashboard →
    </a>
  `);

  return send(opts.to, `🎉 Your LinkMart vendor account is approved!`, html);
}

// ── Send vendor rejection email ────────────────────────────────────────────────
export async function sendVendorRejectedEmail(opts: {
  to:           string;
  businessName: string | undefined;
  reason?:      string | undefined;
}) {
  const reasonBlock = opts.reason ? `
    <div style="background:#FEF2F2;border:1px solid #FEE2E2;border-radius:10px;
      padding:16px;margin-bottom:20px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#9CA3AF;
        text-transform:uppercase;letter-spacing:0.08em;">Reason</p>
      <p style="margin:0;font-size:13px;color:#374151;">${opts.reason}</p>
    </div>` : '';

  const html = shell(`
    <p style="margin:0 0 8px;font-size:22px;font-weight:900;color:#111827;">Application update</p>
    <p style="margin:0 0 16px;font-size:14px;color:#6B7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${opts.businessName ?? 'there'}</strong>, unfortunately
      we're unable to approve your vendor application at this time.
    </p>
    ${reasonBlock}
    <p style="margin:0;font-size:13px;color:#6B7280;line-height:1.6;">
      You're welcome to re-apply after addressing the above.
      If you have questions, reply to this email.
    </p>
  `);

  return send(opts.to, `Update on your LinkMart vendor application`, html);
}

// ── Send booking confirmation to customer ──────────────────────────────────────
export async function sendBookingConfirmationEmail(opts: {
  to:           string;
  customerName: string;
  listingTitle: string;
  startDate:    string;
  endDate:      string;
  totalAmount:  string;
  currency:     string;
  bookingId:    string;
}) {
  const html = shell(`
    <p style="margin:0 0 8px;font-size:22px;font-weight:900;color:#111827;">Booking Confirmed ✅</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6B7280;">
      Hi ${opts.customerName}, your booking has been confirmed.
    </p>
    <table width="100%" style="background:#F8FAFC;border-radius:10px;
      border:1px solid #E5E7EB;padding:16px;margin-bottom:24px;">
      <tr><td style="padding:6px 0;">
        <p style="margin:0;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;">Service</p>
        <p style="margin:2px 0 0;font-size:14px;font-weight:700;color:#111827;">${opts.listingTitle}</p>
      </td></tr>
      <tr><td style="height:1px;background:#E5E7EB;"></td></tr>
      <tr><td style="padding:6px 0;">
        <p style="margin:0;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;">Dates</p>
        <p style="margin:2px 0 0;font-size:13px;color:#374151;">${opts.startDate} → ${opts.endDate}</p>
      </td></tr>
      <tr><td style="height:1px;background:#E5E7EB;"></td></tr>
      <tr><td style="padding:6px 0;">
        <p style="margin:0;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;">Total</p>
        <p style="margin:2px 0 0;font-size:18px;font-weight:900;color:#2D3B45;">
          ${opts.currency} ${opts.totalAmount}</p>
      </td></tr>
    </table>
    <a href="${APP_URL}/customer/bookings/${opts.bookingId}"
      style="display:inline-block;background:#2D3B45;color:#fff;
        font-weight:700;font-size:13px;padding:12px 24px;
        border-radius:10px;text-decoration:none;">
      View Booking →
    </a>
  `);

  return send(opts.to, `Booking confirmed — ${opts.listingTitle}`, html);
}

// ── Notify vendor of new booking ───────────────────────────────────────────────
export async function sendNewBookingNotificationEmail(opts: {
  to:           string;
  vendorName:   string;
  listingTitle: string;
  customerName: string;
  startDate:    string;
  endDate:      string;
  totalAmount:  string;
  currency:     string;
  bookingId:    string;
}) {
  const html = shell(`
    <p style="margin:0 0 8px;font-size:22px;font-weight:900;color:#111827;">New Booking Request 🔔</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6B7280;">
      Hi ${opts.vendorName}, you have a new booking request.
    </p>
    <table width="100%" style="background:#F8FAFC;border-radius:10px;
      border:1px solid #E5E7EB;padding:16px;margin-bottom:24px;">
      <tr><td style="padding:6px 0;">
        <p style="margin:0;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;">Listing</p>
        <p style="margin:2px 0 0;font-size:14px;font-weight:700;color:#111827;">${opts.listingTitle}</p>
      </td></tr>
      <tr><td style="height:1px;background:#E5E7EB;"></td></tr>
      <tr><td style="padding:6px 0;">
        <p style="margin:0;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;">Customer</p>
        <p style="margin:2px 0 0;font-size:13px;color:#374151;">${opts.customerName}</p>
      </td></tr>
      <tr><td style="height:1px;background:#E5E7EB;"></td></tr>
      <tr><td style="padding:6px 0;">
        <p style="margin:0;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;">Dates</p>
        <p style="margin:2px 0 0;font-size:13px;color:#374151;">${opts.startDate} → ${opts.endDate}</p>
      </td></tr>
      <tr><td style="height:1px;background:#E5E7EB;"></td></tr>
      <tr><td style="padding:6px 0;">
        <p style="margin:0;font-size:11px;font-weight:700;color:#9CA3AF;text-transform:uppercase;">Total</p>
        <p style="margin:2px 0 0;font-size:18px;font-weight:900;color:#2D3B45;">
          ${opts.currency} ${opts.totalAmount}</p>
      </td></tr>
    </table>
    <a href="${APP_URL}/vendor/bookings/${opts.bookingId}"
      style="display:inline-block;background:#2D3B45;color:#fff;
        font-weight:700;font-size:13px;padding:12px 24px;
        border-radius:10px;text-decoration:none;">
      Review Booking →
    </a>
  `);

  return send(opts.to, `New booking request — ${opts.listingTitle}`, html);
}