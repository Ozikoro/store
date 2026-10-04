/**
 * Discount codes.
 *
 * A code is validated against the cart at two moments: when the customer applies
 * it, and again immediately before a payment is initialised. The second check is
 * the one that matters — a code can expire, or hit its redemption ceiling,
 * between the two.
 *
 * Redemption is counted when a payment settles, not when a code is typed in.
 * Otherwise a code with ten uses is exhausted by ten people who never buy.
 */

import { db } from './env';
import { randomToken } from './crypto';
import { recordAudit, type AuditActor } from './audit';
import type { DiscountRule } from './pricing';

export interface DiscountRow {
  id: string;
  code: string;
  kind: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  minimum_subtotal_minor: number;
  max_redemptions: number | null;
  redemption_count: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: number;
  created_at: string;
}

export type DiscountCheck =
  | { ok: true; discount: DiscountRow; rule: DiscountRule }
  | { ok: false; reason: string };

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

function parseDate(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Decide whether a code may be used for a basket of this size, at this moment.
 *
 * Pure apart from the lookup, so the same function answers both the "apply" and
 * the "just before payment" question.
 */
export function evaluateDiscount(
  row: DiscountRow | null,
  subtotalMinor: number,
  now: Date = new Date()
): DiscountCheck {
  if (!row) return { ok: false, reason: 'That code was not recognised.' };
  if (!row.is_active) return { ok: false, reason: 'That code is no longer available.' };

  const starts = parseDate(row.starts_at);
  if (starts !== null && now.getTime() < starts) {
    return { ok: false, reason: 'That code is not active yet.' };
  }
  const ends = parseDate(row.ends_at);
  if (ends !== null && now.getTime() > ends) {
    return { ok: false, reason: 'That code has expired.' };
  }
  if (row.max_redemptions !== null && row.redemption_count >= row.max_redemptions) {
    return { ok: false, reason: 'That code has been fully redeemed.' };
  }
  if (subtotalMinor < row.minimum_subtotal_minor) {
    const naira = (row.minimum_subtotal_minor / 100).toLocaleString('en-NG');
    return { ok: false, reason: `That code needs a basket of at least ₦${naira}.` };
  }

  return {
    ok: true,
    discount: row,
    rule: {
      code: row.code,
      kind: row.kind,
      value: row.value,
      minimumSubtotalMinor: row.minimum_subtotal_minor,
    },
  };
}

export async function findDiscount(code: string): Promise<DiscountRow | null> {
  return db()
    .prepare('SELECT * FROM discounts WHERE code = ?1 COLLATE NOCASE')
    .bind(normaliseCode(code))
    .first<DiscountRow>();
}

export async function checkDiscount(
  code: string,
  subtotalMinor: number,
  now: Date = new Date()
): Promise<DiscountCheck> {
  const row = await findDiscount(code);
  return evaluateDiscount(row, subtotalMinor, now);
}

/**
 * Record a redemption. Called from the settlement path, inside the same guard
 * that makes settlement idempotent, so a replayed webhook does not count twice.
 */
export async function redeemDiscount(code: string): Promise<void> {
  const normalised = normaliseCode(code);
  if (!normalised) return;
  await db()
    .prepare(
      `UPDATE discounts
          SET redemption_count = redemption_count + 1
        WHERE code = ?1 COLLATE NOCASE
          AND (max_redemptions IS NULL OR redemption_count < max_redemptions)`
    )
    .bind(normalised)
    .run();
}

export async function listDiscounts(): Promise<DiscountRow[]> {
  const result = await db().prepare('SELECT * FROM discounts ORDER BY created_at DESC').all<DiscountRow>();
  return result.results ?? [];
}

export interface DiscountInput {
  code: string;
  kind: 'percentage' | 'fixed' | 'free_shipping';
  value: number;
  minimumSubtotalMinor?: number;
  maxRedemptions?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

export async function upsertDiscount(input: DiscountInput, actor: AuditActor | null): Promise<DiscountRow> {
  const code = normaliseCode(input.code);
  if (!code) throw new Error('A code needs letters or numbers.');
  if (input.kind === 'percentage' && (input.value < 0 || input.value > 100)) {
    throw new Error('A percentage discount must be between 0 and 100.');
  }
  if (input.kind === 'fixed' && input.value < 0) {
    throw new Error('A fixed discount cannot be negative.');
  }

  const existing = await findDiscount(code);
  if (existing) {
    await db()
      .prepare(
        `UPDATE discounts
            SET kind = ?2, value = ?3, minimum_subtotal_minor = ?4, max_redemptions = ?5,
                starts_at = ?6, ends_at = ?7, is_active = ?8
          WHERE id = ?1`
      )
      .bind(
        existing.id,
        input.kind,
        Math.round(input.value),
        Math.round(input.minimumSubtotalMinor ?? 0),
        input.maxRedemptions ?? null,
        input.startsAt ?? null,
        input.endsAt ?? null,
        input.isActive === false ? 0 : 1
      )
      .run();
    await recordAudit({
      actor,
      action: 'discount.updated',
      entity: 'discount',
      entityId: existing.id,
      before: existing,
      after: input,
    });
    return (await findDiscount(code)) as DiscountRow;
  }

  const id = `dsc_${randomToken(12)}`;
  await db()
    .prepare(
      `INSERT INTO discounts (id, code, kind, value, minimum_subtotal_minor, max_redemptions, starts_at, ends_at, is_active)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      id,
      code,
      input.kind,
      Math.round(input.value),
      Math.round(input.minimumSubtotalMinor ?? 0),
      input.maxRedemptions ?? null,
      input.startsAt ?? null,
      input.endsAt ?? null,
      input.isActive === false ? 0 : 1
    )
    .run();
  await recordAudit({ actor, action: 'discount.created', entity: 'discount', entityId: id, after: input });
  return (await findDiscount(code)) as DiscountRow;
}

export async function setDiscountActive(code: string, active: boolean, actor: AuditActor | null): Promise<void> {
  const row = await findDiscount(code);
  if (!row) throw new Error('No such discount code.');
  await db().prepare('UPDATE discounts SET is_active = ?2 WHERE id = ?1').bind(row.id, active ? 1 : 0).run();
  await recordAudit({
    actor,
    action: active ? 'discount.activated' : 'discount.deactivated',
    entity: 'discount',
    entityId: row.id,
  });
}
