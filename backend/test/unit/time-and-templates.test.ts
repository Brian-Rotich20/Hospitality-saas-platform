import { describe, expect, it } from 'vitest';
import { addMonthsUTC, parseCalendarDate, todayInNairobi } from '../../src/platform/time.js';
import { esc, templates } from '../../src/platform/mailer/templates.js';

describe('addMonthsUTC (trial and billing periods)', () => {
  it('adds one calendar month', () => {
    expect(addMonthsUTC(new Date('2026-03-15T10:00:00Z'), 1).toISOString()).toBe('2026-04-15T10:00:00.000Z');
  });
  it('clamps month-end dates (Jan 31 -> Feb 28 in a non-leap year)', () => {
    expect(addMonthsUTC(new Date('2027-01-31T00:00:00Z'), 1).toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });
  it('handles leap years and year rollover', () => {
    expect(addMonthsUTC(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(addMonthsUTC(new Date('2026-12-15T00:00:00Z'), 1).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});

describe('calendar dates', () => {
  it('rejects impossible dates', () => {
    expect(() => parseCalendarDate('2026-02-30')).toThrow();
    expect(parseCalendarDate('2026-02-28').toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });
  it('uses Nairobi (UTC+3) for "today"', () => {
    expect(todayInNairobi(new Date('2026-11-24T21:30:00Z'))).toBe('2026-11-25');
    expect(todayInNairobi(new Date('2026-11-24T20:59:00Z'))).toBe('2026-11-24');
  });
});

describe('email templates', () => {
  it('escapes user-controlled values', () => {
    expect(esc('<a href="x">"&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&quot;&amp;&#39;&lt;/a&gt;');
    const t = templates.bookingDeclined('<script>alert(1)</script>', 'Venue <b>', 'reason <img src=x>');
    expect(t.html).not.toContain('<script>');
    expect(t.html).not.toContain('<img src=x>');
    expect(t.html).toContain('&lt;script&gt;');
  });
  it('accepted-booking email states that LinkMart does not process the service payment', () => {
    expect(templates.bookingAccepted('A', 'B', 'dates', 'id').html).toContain('LinkMart does not process it');
  });
});
