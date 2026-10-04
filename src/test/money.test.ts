import { describe, expect, it } from 'vitest';

import { computeTotals, type PricedLine } from '../lib/pricing';
import { evaluateDiscount, normaliseCode, type DiscountRow } from '../lib/discounts';
import type { DiscountRule } from '../lib/pricing';

/**
 * The money rules.
 *
 * WHY THESE ARE UNIT TESTS AND NOT PART OF A BROWSER SUITE
 *
 * `computeTotals` and `evaluateDiscount` are pure. A browser run proves the
 * wiring; it cannot cheaply prove that a ₦5,000 fixed discount on a ₦4,000
 * basket clamps to ₦4,000 rather than making the store owe the customer ₦1,000.
 * These are the rules where a mistake costs money rather than goodwill, so they
 * are asserted against the real functions the application ships — never against a
 * reimplementation of them, which would pass while the shop was wrong.
 *
 * The values are the ones actually seeded: LAUNCH10 (10%),
 * FREESHIPNG (free shipping above ₦50,000), WELCOME5000 (₦5,000 off above
 * ₦25,000).
 */

const SHIPPING = 250_000; // the Lagos rate, ₦2,500
const READER = 2_400_000; // ₦24,000, one seeded reader

/** A `DiscountRule`, which is what `computeTotals` accepts — not a database row. */
function rule(overrides: Partial<DiscountRule> = {}): DiscountRule {
  return {
    code: 'LAUNCH10',
    kind: 'percentage',
    value: 10,
    minimumSubtotalMinor: 0,
    ...overrides,
  };
}

function row(overrides: Partial<DiscountRow> = {}): DiscountRow {
  return {
    id: 'dsc_test',
    code: 'TEST',
    kind: 'percentage',
    value: 0,
    minimum_subtotal_minor: 0,
    max_redemptions: null,
    redemption_count: 0,
    starts_at: null,
    ends_at: null,
    is_active: 1,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

/**
 * A priced line.
 *
 * `computeTotals` reads only `unitPriceMinor` and `quantity`, but the type carries
 * the whole line because that is what the cart passes. Building a complete line
 * keeps the test honest about the shape the real code sees, rather than relying on
 * the function happening to ignore the rest.
 */
function line(unitPriceMinor: number, quantity = 1): PricedLine {
  return {
    variantId: 'var_test',
    productId: 'prd_test',
    productSlug: 'the-ozikoro-reader',
    title: 'The Ozikoro Reader',
    variantTitle: 'Hardcover',
    sku: 'OZK-RDR-HC',
    imageUrl: '/media/ozikoro-reader.jpg',
    unitPriceMinor,
    quantity,
    availableStock: 10,
    isActive: true,
  };
}

const basket = (unitPriceMinor: number, quantity = 1) => [line(unitPriceMinor, quantity)];

describe('a basket with no discount', () => {
  it('adds shipping to the goods and nothing else', () => {
    const t = computeTotals({ lines: basket(READER), shippingMinor: SHIPPING, discount: null });
    expect(t.subtotalMinor).toBe(READER);
    expect(t.discountMinor).toBe(0);
    expect(t.shippingMinor).toBe(SHIPPING);
    expect(t.taxMinor).toBe(0);
    expect(t.totalMinor).toBe(READER + SHIPPING);
    expect(t.freeShipping).toBe(false);
  });
});

describe('a percentage code', () => {
  it('takes its percentage from the goods, never from shipping', () => {
    const t = computeTotals({ lines: basket(READER), shippingMinor: SHIPPING, discount: rule() });
    // 10% of 2,400,000 — not of 2,650,000, which would be 265,000.
    expect(t.discountMinor).toBe(240_000);
    expect(t.shippingMinor).toBe(SHIPPING);
    expect(t.totalMinor).toBe(2_410_000);
  });

  it('multiplies quantity before discounting', () => {
    const t = computeTotals({
      lines: basket(1_000_000, 3),
      shippingMinor: SHIPPING,
      discount: rule(),
    });
    expect(t.subtotalMinor).toBe(3_000_000);
    expect(t.discountMinor).toBe(300_000);
    expect(t.itemCount).toBe(3);
  });

  it('never invents or loses a kobo', () => {
    for (const [price, percent] of [
      [1, 10],
      [3, 33],
      [999, 7],
      [12345, 15],
      [2_400_000, 10],
    ] as const) {
      const t = computeTotals({
        lines: basket(price),
        shippingMinor: 0,
        discount: rule({ value: percent }),
      });
      expect(Number.isInteger(t.discountMinor)).toBe(true);
      expect(Number.isInteger(t.totalMinor)).toBe(true);
      expect(t.discountMinor).toBeGreaterThanOrEqual(0);
      expect(t.discountMinor).toBeLessThanOrEqual(price);
      expect(t.totalMinor).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('a fixed-amount code', () => {
  const fiveThousand = rule({ kind: 'fixed', value: 500_000, code: 'WELCOME5000' });

  it('comes off the goods', () => {
    const t = computeTotals({ lines: basket(READER), shippingMinor: SHIPPING, discount: fiveThousand });
    expect(t.discountMinor).toBe(500_000);
    expect(t.totalMinor).toBe(2_150_000);
  });

  it('can never exceed the goods, so the store never owes the customer money', () => {
    // THE RULE THAT MATTERS. A ₦5,000 code on a ₦4,000 basket must clamp.
    const t = computeTotals({ lines: basket(400_000), shippingMinor: SHIPPING, discount: fiveThousand });
    expect(t.discountMinor).toBe(400_000);
    expect(t.totalMinor).toBe(SHIPPING); // shipping alone, never negative
    expect(t.totalMinor).toBeGreaterThanOrEqual(0);
  });
});

describe('a free-shipping code', () => {
  it('zeroes the shipping line and leaves the goods alone', () => {
    const t = computeTotals({
      lines: basket(READER),
      shippingMinor: SHIPPING,
      discount: rule({ kind: 'free_shipping', value: 0, code: 'FREESHIPNG' }),
    });
    expect(t.shippingMinor).toBe(0);
    expect(t.discountMinor).toBe(0);
    expect(t.freeShipping).toBe(true);
    expect(t.totalMinor).toBe(READER);
  });
});

describe('a code below its minimum is not applied', () => {
  const fiftyThousand = rule({
    kind: 'free_shipping',
    value: 0,
    minimumSubtotalMinor: 5_000_000,
  });

  it('is ignored when the basket is too small', () => {
    const t = computeTotals({ lines: basket(READER), shippingMinor: SHIPPING, discount: fiftyThousand });
    expect(t.shippingMinor).toBe(SHIPPING);
    expect(t.totalMinor).toBe(READER + SHIPPING);
  });

  it('applies at exactly the minimum, because the comparison is inclusive', () => {
    const t = computeTotals({ lines: basket(5_000_000), shippingMinor: SHIPPING, discount: fiftyThousand });
    expect(t.shippingMinor).toBe(0);
  });
});

describe('code normalisation', () => {
  it('accepts what a person actually types', () => {
    expect(normaliseCode('launch10')).toBe('LAUNCH10');
    expect(normaliseCode('  LAUNCH10  ')).toBe('LAUNCH10');
    expect(normaliseCode('launch 10')).toBe('LAUNCH10');
  });
});

describe('eligibility at the edges', () => {
  const now = new Date('2026-10-04T12:00:00Z');

  it('refuses an unknown code', () => {
    expect(evaluateDiscount(null, 1_000_000, now).ok).toBe(false);
  });

  it('refuses a code that is switched off', () => {
    expect(evaluateDiscount(row({ is_active: 0 }), 1_000_000, now).ok).toBe(false);
  });

  it('refuses a code that has expired, and accepts one that has not yet', () => {
    const expired = evaluateDiscount(row({ ends_at: '2026-01-31T23:59:59Z' }), 1_000_000, now);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toMatch(/expired/i);

    expect(evaluateDiscount(row({ ends_at: '2026-10-04T12:00:01Z' }), 1_000_000, now).ok).toBe(true);
    expect(evaluateDiscount(row({ ends_at: '2026-10-04T11:59:59Z' }), 1_000_000, now).ok).toBe(false);
  });

  it('refuses a code that has not started', () => {
    const notYet = evaluateDiscount(row({ starts_at: '2026-11-01T00:00:00Z' }), 1_000_000, now);
    expect(notYet.ok).toBe(false);
    if (!notYet.ok) expect(notYet.reason).toMatch(/not active yet/i);
  });

  it('refuses a fully redeemed code and accepts one with a redemption left', () => {
    expect(
      evaluateDiscount(row({ max_redemptions: 500, redemption_count: 500 }), 1_000_000, now).ok
    ).toBe(false);
    expect(
      evaluateDiscount(row({ max_redemptions: 500, redemption_count: 499 }), 1_000_000, now).ok
    ).toBe(true);
  });

  it('treats an unlimited code as unlimited', () => {
    expect(
      evaluateDiscount(row({ max_redemptions: null, redemption_count: 999_999 }), 1_000_000, now).ok
    ).toBe(true);
  });

  it('is exact about the minimum, to the kobo', () => {
    const minimum = row({ minimum_subtotal_minor: 5_000_000 });
    const below = evaluateDiscount(minimum, 4_999_999, now);
    expect(below.ok).toBe(false);
    if (!below.ok) expect(below.reason).toMatch(/at least/i);
    expect(evaluateDiscount(minimum, 5_000_000, now).ok).toBe(true);
  });

  it('passes the code through to the rule, so the total can apply it', () => {
    const accepted = evaluateDiscount(row({ code: 'LAUNCH10', kind: 'percentage', value: 10 }), 1_000_000, now);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.rule.code).toBe('LAUNCH10');
      expect(accepted.rule.kind).toBe('percentage');
      expect(accepted.rule.value).toBe(10);
    }
  });
});
