/**
 * Cart and order arithmetic.
 *
 * This module is deliberately free of any database access, so it can be tested
 * exhaustively and so there is exactly one implementation of the rules that
 * decide what a customer pays. The server calls it to produce the authoritative
 * total; the browser may call the same functions to preview that total, and the
 * server never accepts the browser's answer.
 *
 * The one property that matters most: a total is recomputed from the catalogue
 * at the moment of payment, not read from anything the client sent.
 */

import { sumMinor, applyDiscount, percentOf, DEFAULT_CURRENCY } from './money';

export interface PricedLine {
  variantId: string;
  productId: string;
  productSlug: string;
  title: string;
  variantTitle: string;
  sku: string;
  imageUrl: string;
  unitPriceMinor: number;
  quantity: number;
  /** Stock available for this variant, or null when made to order. */
  availableStock: number | null;
  isActive: boolean;
}

export interface ShippingQuote {
  method: string;
  label: string;
  amountMinor: number;
  estimate: string;
}

export interface DiscountRule {
  code: string;
  kind: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  minimumSubtotalMinor: number;
}

/**
 * Nigeria-first shipping. Rates are per the handoff: domestic by default,
 * international only where operationally supported.
 *
 * Lagos is separated because that is where the store ships from and the courier
 * rate genuinely differs. International is a single flat band for now — a
 * country-by-country rate card is the kind of thing that should be built when
 * there is real volume to base it on, and the handoff defers complex
 * international inventory.
 */
export const SHIPPING_RATES = {
  LAGOS: 2500_00,
  NIGERIA: 5000_00,
  INTERNATIONAL: 65000_00,
  /** Spend this much domestically and shipping is on the store. */
  FREE_THRESHOLD_NG: 150000_00,
} as const;

const LAGOS_NAMES = ['lagos', 'ikeja', 'lekki', 'ikoyi', 'victoria island', 'yaba', 'surulere', 'ajah', 'apapa'];

export function isLagos(region: string, city: string): boolean {
  const haystack = `${region} ${city}`.toLowerCase();
  return LAGOS_NAMES.some((name) => haystack.includes(name));
}

export function isNigeria(country: string): boolean {
  const value = country.trim().toLowerCase();
  return value === 'nigeria' || value === 'ng' || value === 'nga';
}

/**
 * Quote shipping for an address and a subtotal.
 *
 * Returns the options the customer may choose, cheapest-first. An empty array
 * means the address is one the store cannot yet serve — checkout then refuses,
 * rather than inventing a rate.
 */
export function quoteShipping(input: {
  country: string;
  region?: string | undefined;
  city?: string | undefined;
  subtotalMinor: number;
  /** Digital-only baskets do not ship. */
  requiresShipping?: boolean | undefined;
}): ShippingQuote[] {
  if (input.requiresShipping === false) {
    return [{ method: 'digital', label: 'Digital delivery', amountMinor: 0, estimate: 'Immediately after payment' }];
  }

  if (!isNigeria(input.country)) {
    return [
      {
        method: 'international',
        label: 'International courier',
        amountMinor: SHIPPING_RATES.INTERNATIONAL,
        estimate: '7–21 working days, duties payable on delivery',
      },
    ];
  }

  const freeDomestic = input.subtotalMinor >= SHIPPING_RATES.FREE_THRESHOLD_NG;

  if (isLagos(input.region ?? '', input.city ?? '')) {
    return [
      {
        method: 'lagos',
        label: 'Lagos delivery',
        amountMinor: freeDomestic ? 0 : SHIPPING_RATES.LAGOS,
        estimate: '1–3 working days',
      },
      {
        method: 'nigeria',
        label: 'Nationwide courier',
        amountMinor: freeDomestic ? 0 : SHIPPING_RATES.NIGERIA,
        estimate: '3–7 working days',
      },
    ];
  }

  return [
    {
      method: 'nigeria',
      label: 'Nationwide courier',
      amountMinor: freeDomestic ? 0 : SHIPPING_RATES.NIGERIA,
      estimate: '3–7 working days',
    },
  ];
}

export function shippingMethodFor(quotes: ShippingQuote[], method: string): ShippingQuote | null {
  return quotes.find((quote) => quote.method === method) ?? quotes[0] ?? null;
}

export interface TotalsInput {
  lines: PricedLine[];
  shippingMinor: number;
  discount?: DiscountRule | null;
  /** Subtotal the discount code has already been validated against. */
}

export interface Totals {
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  itemCount: number;
  freeShipping: boolean;
}

/**
 * The single source of truth for what an order costs.
 *
 * Order of operations is fixed and non-negotiable:
 *   subtotal → discount → shipping → tax → total.
 * A percentage discount applies to the goods, never to shipping, and a
 * free-shipping code zeroes the shipping line. Tax is 0 for now (Nigerian VAT on
 * physical goods is handled at the company level, not per-cart); it is a named
 * term rather than an omission so that adding it later is one line, not a
 * redesign.
 */
export function computeTotals(input: TotalsInput): Totals {
  const subtotalMinor = sumMinor(input.lines.map((line) => line.unitPriceMinor * line.quantity));
  const itemCount = input.lines.reduce((count, line) => count + line.quantity, 0);

  let discountMinor = 0;
  let freeShipping = false;

  const rule = input.discount ?? null;
  if (rule && subtotalMinor >= rule.minimumSubtotalMinor) {
    if (rule.kind === 'percentage') {
      discountMinor = percentOf(subtotalMinor, Math.min(100, Math.max(0, rule.value)));
    } else if (rule.kind === 'fixed') {
      // A fixed discount can never exceed the goods: a ₦0 order is refunded, a
      // negative order would mean the store owes the customer money for nothing.
      discountMinor = Math.min(rule.value, subtotalMinor);
    } else if (rule.kind === 'free_shipping') {
      freeShipping = true;
    }
  }

  const shippingMinor = freeShipping ? 0 : Math.max(0, input.shippingMinor);
  const taxMinor = 0;
  const totalMinor = applyDiscount(subtotalMinor, discountMinor) + shippingMinor + taxMinor;

  return {
    subtotalMinor,
    discountMinor,
    shippingMinor,
    taxMinor,
    totalMinor,
    itemCount,
    freeShipping,
  };
}

export interface StockProblem {
  variantId: string;
  title: string;
  variantTitle: string;
  requested: number;
  available: number;
}

/**
 * The out-of-stock guard.
 *
 * The handoff requires that an out-of-stock item cannot be purchased
 * accidentally, so this runs before a payment is ever initialised. It checks the
 * requested quantity against live stock rather than against the number the
 * browser last saw.
 */
export function findStockProblems(lines: PricedLine[]): StockProblem[] {
  const problems: StockProblem[] = [];
  for (const line of lines) {
    if (!line.isActive) {
      problems.push({
        variantId: line.variantId,
        title: line.title,
        variantTitle: line.variantTitle,
        requested: line.quantity,
        available: 0,
      });
      continue;
    }
    // A made-to-order line has no stock ceiling by design.
    if (line.availableStock === null) continue;
    if (line.quantity > line.availableStock) {
      problems.push({
        variantId: line.variantId,
        title: line.title,
        variantTitle: line.variantTitle,
        requested: line.quantity,
        available: line.availableStock,
      });
    }
  }
  return problems;
}

export function describeStockProblem(problem: StockProblem): string {
  const variant = problem.variantTitle ? ` (${problem.variantTitle})` : '';
  if (problem.available <= 0) return `${problem.title}${variant} is out of stock.`;
  return `Only ${problem.available} of ${problem.title}${variant} left — you asked for ${problem.requested}.`;
}

export function currencyOf(lines: PricedLine[], fallback: string = DEFAULT_CURRENCY): string {
  return lines.length ? fallback : fallback;
}
