// Vendor business contact: the public email, phone and WhatsApp number shown on every
// listing of a vendor. Kept on the vendor profile (never per listing) and separate from the
// owner's login email.
import { z } from 'zod';

/**
 * Normalises a phone number to international (E.164) format, or returns null if invalid.
 * Kenyan numbers may be written locally (0712 345 678, 0110 …, 020 …) or with 254/+254;
 * other countries must be written in international form (+44 20 …). Spaces, dashes, dots
 * and brackets are ignored.
 */
export function normalisePhone(input: string): string | null {
  const s = input.trim().replace(/[\s\-.()]/g, '');
  let m = /^0(\d{9})$/.exec(s);                       // Kenyan national format
  if (m) return `+254${m[1]}`;
  m = /^\+?254(\d{9})$/.exec(s);                      // Kenyan with country code
  if (m) return `+254${m[1]}`;
  m = /^\+([1-9]\d{7,14})$/.exec(s);                  // any other E.164 number
  if (m) return `+${m[1]}`;
  return null;
}

/** Zod field: a phone number normalised to E.164; null or "" clears it. */
export const contactPhone = z.union([z.literal(''), z.null(), z.string().max(32)])
  .transform((v, ctx) => {
    if (v === null || v === '') return null;
    const n = normalisePhone(v);
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number, e.g. 0712 345 678 or +254 712 345 678' });
      return z.NEVER;
    }
    return n;
  });

/** Zod field: business email, lower-cased; null or "" clears it. */
export const contactEmail = z.union([z.literal(''), z.null(), z.string().trim().toLowerCase().email('Enter a valid email address').max(255)])
  .transform((v) => (v === '' ? null : v));

export interface ContactFields { businessEmail: string | null; phoneNumber: string | null; whatsappNumber: string | null }

/** Contact fields a vendor must have before publishing a listing (API field names). */
export function missingContact(v: ContactFields): (keyof ContactFields)[] {
  const missing: (keyof ContactFields)[] = [];
  if (!v.businessEmail) missing.push('businessEmail');
  if (!v.phoneNumber) missing.push('phoneNumber');
  if (!v.whatsappNumber) missing.push('whatsappNumber');
  return missing;
}
