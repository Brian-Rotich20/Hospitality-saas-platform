// Email templates. Every dynamic value passes through `esc()`, so user-controlled text
// (names, listing titles, reasons, messages) can't inject markup or links.
import { env } from '../config/env.js';

export function esc(value: string | number | null | undefined): string {
  return (value == null ? '' : String(value))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function link(path: string): string {
  return esc(new URL(path, env.FRONTEND_URL).toString());
}

function layout(title: string, body: string, cta?: { label: string; path: string }): string {
  const button = cta
    ? `<p style="margin:24px 0 0;"><a href="${link(cta.path)}" style="display:inline-block;background:#2D3B45;color:#fff;font-weight:700;font-size:13px;padding:12px 24px;border-radius:10px;text-decoration:none;">${esc(cta.label)}</a></p>`
    : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F8FAFC;font-family:system-ui,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;"><tr><td align="center">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;border:1px solid #E5E7EB;overflow:hidden;">
<tr><td style="background:#2D3B45;padding:28px 32px;"><p style="margin:0;font-size:20px;font-weight:900;color:#F5C842;">LinkMart</p>
<p style="margin:4px 0 0;font-size:11px;color:#ffffff80;text-transform:uppercase;letter-spacing:0.1em;">Kenya's Hospitality Marketplace</p></td></tr>
<tr><td style="padding:32px;"><p style="margin:0 0 16px;font-size:22px;font-weight:900;color:#111827;">${esc(title)}</p>
<div style="font-size:14px;color:#374151;line-height:1.6;">${body}</div>${button}</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #F3F4F6;background:#F9FAFB;"><p style="margin:0;font-size:11px;color:#9CA3AF;text-align:center;">© ${new Date().getUTCFullYear()} LinkMart</p></td></tr>
</table></td></tr></table></body></html>`;
}

const p = (text: string): string => `<p style="margin:0 0 12px;">${text}</p>`;

export interface Rendered { subject: string; html: string }

export const templates = {
  emailOtp(name: string, otp: string): Rendered {
    return {
      subject: 'Verify your LinkMart account',
      html: layout('Verify your email', p(`Hi ${esc(name)}, use this code to verify your email. It expires in 15 minutes.`)
        + `<p style="margin:16px 0;font-size:36px;font-weight:900;letter-spacing:0.2em;color:#2D3B45;">${esc(otp)}</p>`
        + p("If you didn't create an account, ignore this email.")),
    };
  },

  bookingRequested(vendorName: string, listingTitle: string, dates: string, bookingId: string, respondByIso: string): Rendered {
    return {
      subject: `New booking request: ${listingTitle}`,
      html: layout('New booking request', p(`Hi ${esc(vendorName)}, you have a new request for <strong>${esc(listingTitle)}</strong> (${esc(dates)}).`)
        + p(`Please accept or decline by <strong>${esc(respondByIso)}</strong> (UTC). Requests without a response expire automatically.`),
      { label: 'Review request', path: `/vendor/bookings/${bookingId}` }),
    };
  },

  bookingAccepted(customerName: string, listingTitle: string, dates: string, bookingId: string): Rendered {
    return {
      subject: `Request accepted: ${listingTitle}`,
      html: layout('Your request was accepted', p(`Hi ${esc(customerName)}, the vendor accepted your request for <strong>${esc(listingTitle)}</strong> (${esc(dates)}).`)
        + p('You can now message the vendor to arrange details. Payment for the service is agreed directly with the vendor; LinkMart does not process it.'),
      { label: 'Open conversation', path: `/customer/bookings/${bookingId}` }),
    };
  },

  bookingDeclined(customerName: string, listingTitle: string, reason: string): Rendered {
    return {
      subject: `Request declined: ${listingTitle}`,
      html: layout('Your request was declined', p(`Hi ${esc(customerName)}, the vendor declined your request for <strong>${esc(listingTitle)}</strong>.`)
        + p(`Reason: ${esc(reason)}`)),
    };
  },

  bookingExpired(name: string, listingTitle: string, forVendor: boolean): Rendered {
    return {
      subject: `Request expired: ${listingTitle}`,
      html: layout('Booking request expired', p(`Hi ${esc(name)}, the request for <strong>${esc(listingTitle)}</strong> expired because it wasn't answered within the response window.`)
        + (forVendor ? p('Respond to requests promptly to keep customers engaged.') : p('You can send a new request or choose another listing.'))),
    };
  },

  bookingCancelled(name: string, listingTitle: string, cancelledBy: string, reason: string): Rendered {
    return {
      subject: `Booking cancelled: ${listingTitle}`,
      html: layout('Booking cancelled', p(`Hi ${esc(name)}, the booking for <strong>${esc(listingTitle)}</strong> was cancelled by the ${esc(cancelledBy)}.`)
        + p(`Reason: ${esc(reason)}`)),
    };
  },

  newMessage(name: string, listingTitle: string, conversationId: string): Rendered {
    return {
      subject: `New message about ${listingTitle}`,
      html: layout('You have a new message', p(`Hi ${esc(name)}, you have a new message about <strong>${esc(listingTitle)}</strong>.`),
        { label: 'Read message', path: `/messages/${conversationId}` }),
    };
  },

  trialEnding(businessName: string, trialEndsIso: string, daysLeft: number): Rendered {
    return {
      subject: `Your LinkMart free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      html: layout('Your free trial is ending', p(`Hi ${esc(businessName)}, your free month ends on <strong>${esc(trialEndsIso)}</strong> (UTC).`)
        + p('After that, a monthly subscription keeps your listings visible and lets you accept booking requests.'),
      { label: 'View subscription', path: '/vendor/subscription' }),
    };
  },

  paymentDue(businessName: string, amount: string, dueIso: string, graceEndsIso: string): Rendered {
    return {
      subject: 'Your LinkMart subscription payment is due',
      html: layout('Subscription payment due', p(`Hi ${esc(businessName)}, your monthly subscription of <strong>${esc(amount)}</strong> was due on ${esc(dueIso)}.`)
        + p(`Pay by <strong>${esc(graceEndsIso)}</strong> (UTC) with M-Pesa or card to avoid your listings being hidden.`),
      { label: 'Pay now', path: '/vendor/subscription' }),
    };
  },

  paymentSucceeded(businessName: string, amount: string, periodEndIso: string, reference: string): Rendered {
    return {
      subject: 'Payment received: LinkMart subscription',
      html: layout('Payment received', p(`Hi ${esc(businessName)}, we received <strong>${esc(amount)}</strong>. Your subscription is active until ${esc(periodEndIso)} (UTC).`)
        + p(`Reference: ${esc(reference)}`)),
    };
  },

  paymentFailed(businessName: string, amount: string, reason: string): Rendered {
    return {
      subject: 'Subscription payment failed',
      html: layout('Payment failed', p(`Hi ${esc(businessName)}, your payment of ${esc(amount)} did not go through (${esc(reason)}).`)
        + p('You can try again with M-Pesa or card.'),
      { label: 'Try again', path: '/vendor/subscription' }),
    };
  },

  subscriptionSuspended(businessName: string): Rendered {
    return {
      subject: 'Your LinkMart listings are paused',
      html: layout('Subscription suspended', p(`Hi ${esc(businessName)}, your subscription payment is overdue, so your listings are hidden and you can't accept new requests.`)
        + p('Your existing accepted bookings and messages are unaffected. Pay the outstanding invoice to restore access.'),
      { label: 'Pay now', path: '/vendor/subscription' }),
    };
  },

  subscriptionExpired(businessName: string): Rendered {
    return {
      subject: 'Your LinkMart subscription has expired',
      html: layout('Subscription expired', p(`Hi ${esc(businessName)}, your subscription has expired after a long period without payment. Your listings remain hidden.`)
        + p('Your account, listings and booking history are kept. You can resubscribe at any time to restore access.'),
      { label: 'Resubscribe', path: '/vendor/subscription' }),
    };
  },
};
