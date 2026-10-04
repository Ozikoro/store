/**
 * Money, in minor units, everywhere.
 *
 * Every amount in this application is an INTEGER number of kobo. There is no
 * function here that takes or returns a float naira amount, because the moment
 * one exists somebody will use it for a total and the total will be wrong by a
 * kobo. `formatMoney` is the only place a decimal point is ever introduced, and
 * it returns a string for display.
 */

export const DEFAULT_CURRENCY = 'NGN';

const SYMBOLS: Record<string, string> = {
  NGN: '\u20a6',
  USD: '$',
  GBP: '\u00a3',
  EUR: '\u20ac',
  GHS: 'GH\u20b5',
  ZAR: 'R',
  KES: 'KSh',
};

/** Parse a human '18500' / '18,500.50' / '18500.5' into minor units. */
export function parseMajorToMinor(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Amount is not a finite number');
    return Math.round(input * 100);
  }
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') throw new Error('Amount is not a number');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) throw new Error('Amount is not a finite number');
  return Math.round(value * 100);
}

/** '18500' -> 185.00, as a fixed 2dp string. For forms and admin tables. */
export function minorToMajorString(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** `₦18,500` — display only, never arithmetic. */
export function formatMoney(minor: number, currency: string = DEFAULT_CURRENCY): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  const grouped = whole.toLocaleString('en-NG');
  const sign = minor < 0 ? '-' : '';
  // Whole naira is the norm in this store; a trailing '.00' on every price is
  // noise, but a genuine kobo remainder must never be hidden.
  return fraction === 0 ? `${sign}${symbol}${grouped}` : `${sign}${symbol}${grouped}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Sum without ever leaving integer space. `reduce` with `+` on integers is exact
 * up to 2^53, and a store's lifetime revenue is far below that in kobo.
 */
export function sumMinor(values: number[]): number {
  return values.reduce((total, value) => total + Math.round(value), 0);
}

/** A discount, clamped so a total can never go negative. */
export function applyDiscount(subtotalMinor: number, discountMinor: number): number {
  return Math.max(0, subtotalMinor - Math.max(0, discountMinor));
}

export function percentOf(minor: number, percent: number): number {
  return Math.round((minor * percent) / 100);
}
