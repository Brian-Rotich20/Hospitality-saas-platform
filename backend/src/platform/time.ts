// Time helpers. All instants are UTC; calendar dates are YYYY-MM-DD strings.

const DAY_MS = 86_400_000;

/** Add calendar months in UTC, clamping to the last day of the target month (Jan 31 + 1 = Feb 28/29). */
export function addMonthsUTC(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDay);
  return new Date(Date.UTC(targetYear, targetMonth, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3_600_000);
}

/** 'YYYY-MM-DD' -> midnight UTC Date. Rejects impossible dates such as 2026-02-30. */
export function parseCalendarDate(value: string): Date {
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new RangeError(`invalid calendar date: ${value}`);
  return d;
}

export function toCalendarDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in Kenya (UTC+3, no DST). */
export function todayInNairobi(now = new Date()): string {
  return toCalendarDate(new Date(now.getTime() + 3 * 3_600_000));
}

export function formatMoney(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
