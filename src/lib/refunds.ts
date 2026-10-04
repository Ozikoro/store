/**
 * Refunds and returns.
 *
 * A refund is requested, approved, then executed against the gateway. The three
 * steps exist because money leaving the business is the one action that must not
 * be a single click on a misread row.
 *
 * `executeRefund` is the only function that calls Paystack's refund endpoint and
 * the only one that writes `quantity_refunded`. Both are guarded so a retry —
 * and a refund request is exactly the kind of thing that gets double-clicked —
 * cannot refund the same naira twice.
 */

import { db } from './env';
import { randomToken } from './crypto';
import { recordAudit, type AuditActor } from './audit';
import { refundTransaction } from './paystack';
import { orderItems, findOrderById, findPaymentByReference, paymentsForOrder, returnOrderStock, updateOrderStatus } from './orders';

export interface RefundRow {
  id: string;
  order_id: string;
  payment_id: string | null;
  amount_minor: number;
  reason: string;
  status: 'requested' | 'approved' | 'processing' | 'completed' | 'failed';
  provider_reference: string | null;
  restock: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function refundsForOrder(orderId: string): Promise<RefundRow[]> {
  const result = await db()
    .prepare('SELECT * FROM refunds WHERE order_id = ?1 ORDER BY created_at DESC')
    .bind(orderId)
    .all<RefundRow>();
  return result.results ?? [];
}

export async function listRefunds(limit = 100): Promise<RefundRow[]> {
  const result = await db()
    .prepare('SELECT * FROM refunds ORDER BY created_at DESC LIMIT ?1')
    .bind(limit)
    .all<RefundRow>();
  return result.results ?? [];
}

/** How much may still be refunded on an order. */
export async function refundableMinor(orderId: string): Promise<number> {
  const order = await findOrderById(orderId);
  if (!order) return 0;
  const row = await db()
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS refunded
         FROM refunds
        WHERE order_id = ?1 AND status IN ('approved','processing','completed')`
    )
    .bind(orderId)
    .first<{ refunded: number }>();
  const already = row?.refunded ?? 0;
  return Math.max(0, order.total_minor - already);
}

export class RefundError extends Error {
  readonly status = 409;
}

export async function requestRefund(input: {
  orderId: string;
  amountMinor: number;
  reason: string;
  restock?: boolean;
  actor: AuditActor | null;
}): Promise<RefundRow> {
  const order = await findOrderById(input.orderId);
  if (!order) throw new RefundError('No such order.');
  if (order.payment_status !== 'paid' && order.payment_status !== 'partially_refunded') {
    throw new RefundError('Only a paid order can be refunded.');
  }

  const amount = Math.round(input.amountMinor);
  if (amount <= 0) throw new RefundError('A refund needs an amount.');

  const remaining = await refundableMinor(input.orderId);
  if (amount > remaining) {
    throw new RefundError(`That is more than is left to refund (${(remaining / 100).toFixed(2)}).`);
  }

  const id = `ref_${randomToken(12)}`;
  await db()
    .prepare(
      `INSERT INTO refunds (id, order_id, amount_minor, reason, status, restock, created_by)
       VALUES (?1, ?2, ?3, ?4, 'requested', ?5, ?6)`
    )
    .bind(id, input.orderId, amount, input.reason.slice(0, 2000), input.restock === false ? 0 : 1, input.actor?.email ?? '')
    .run();

  await db()
    .prepare(`UPDATE orders SET status = 'partially_refunded', updated_at = datetime('now') WHERE id = ?1 AND status != 'refunded'`)
    .bind(input.orderId)
    .run();

  await recordAudit({
    actor: input.actor,
    action: 'refund.requested',
    entity: 'refund',
    entityId: id,
    after: { orderId: input.orderId, amountMinor: amount, reason: input.reason },
  });

  const row = await db().prepare('SELECT * FROM refunds WHERE id = ?1').bind(id).first<RefundRow>();
  if (!row) throw new RefundError('Refund was not created.');
  return row;
}

/**
 * Execute an approved refund against Paystack, and restock if asked.
 *
 * The guard is the refund row's own status: only a `requested` or `approved`
 * row can be executed, and the UPDATE that claims it is conditional, so two
 * concurrent clicks cannot both reach the gateway.
 */
export async function executeRefund(refundId: string, actor: AuditActor | null): Promise<RefundRow> {
  const refund = await db().prepare('SELECT * FROM refunds WHERE id = ?1').bind(refundId).first<RefundRow>();
  if (!refund) throw new RefundError('No such refund.');
  if (refund.status === 'completed') return refund;
  if (refund.status !== 'requested' && refund.status !== 'approved') {
    throw new RefundError(`A refund that is ${refund.status} cannot be executed.`);
  }

  const claim = await db()
    .prepare(`UPDATE refunds SET status = 'processing', updated_at = datetime('now') WHERE id = ?1 AND status IN ('requested','approved')`)
    .bind(refundId)
    .run();
  if (!claim.meta || (claim.meta['changes'] as number) === 0) {
    const current = await db().prepare('SELECT * FROM refunds WHERE id = ?1').bind(refundId).first<RefundRow>();
    return current ?? refund;
  }

  const payments = await paymentsForOrder(refund.order_id);
  const settled = payments.find((payment) => payment.status === 'success' && payment.provider_reference);

  if (!settled?.provider_reference) {
    await failRefund(refundId, 'No settled payment to refund against.');
    throw new RefundError('This order has no settled payment to refund against.');
  }

  const result = await refundTransaction({
    providerReference: settled.provider_reference,
    amountMinor: refund.amount_minor,
  });

  if (!result.ok) {
    await failRefund(refundId, result.message);
    throw new RefundError(result.message);
  }

  await db()
    .prepare(
      `UPDATE refunds
          SET status = 'completed', provider_reference = ?2, updated_at = datetime('now')
        WHERE id = ?1`
    )
    .bind(refundId, result.providerReference ?? settled.provider_reference)
    .run();

  if (refund.restock === 1) {
    await restockRefund(refund.order_id, refund.amount_minor, actor);
  }

  await settleOrderAfterRefund(refund.order_id);

  await recordAudit({
    actor,
    action: 'refund.completed',
    entity: 'refund',
    entityId: refundId,
    after: { amountMinor: refund.amount_minor, orderId: refund.order_id },
  });

  const updated = await db().prepare('SELECT * FROM refunds WHERE id = ?1').bind(refundId).first<RefundRow>();
  if (!updated) throw new RefundError('Refund disappeared during execution.');
  return updated;
}

async function failRefund(refundId: string, reason: string): Promise<void> {
  await db()
    .prepare(
      `UPDATE refunds SET status = 'failed', reason = reason || ' — ' || ?2, updated_at = datetime('now') WHERE id = ?1`
    )
    .bind(refundId, reason)
    .run();
}

/**
 * Put refunded units back.
 *
 * Guarded by the inventory ledger exactly as `returnOrderStock` is, so a
 * refund that is executed twice cannot inflate stock twice.
 */
async function restockRefund(orderId: string, amountMinor: number, actor: AuditActor | null): Promise<void> {
  const already = await db()
    .prepare(`SELECT COUNT(*) AS n FROM inventory_movements WHERE order_id = ?1 AND reason = 'refund_restock'`)
    .bind(orderId)
    .first<{ n: number }>();
  if ((already?.n ?? 0) > 0) return;

  const order = await findOrderById(orderId);
  if (!order) return;

  // A partial refund of the money does not identify which units came back, so
  // restocking is only automatic for a refund of the whole order. Anything else
  // is a judgement the shop makes by hand, and the admin UI says so.
  if (amountMinor < order.total_minor) return;

  const items = await orderItems(orderId);
  const statements = [];
  for (const item of items) {
    if (!item.variant_id) continue;
    const quantity = item.quantity - item.quantity_refunded;
    if (quantity <= 0) continue;
    statements.push(
      db().prepare(`UPDATE order_items SET quantity_refunded = quantity WHERE id = ?1`).bind(item.id)
    );
    statements.push(
      db()
        .prepare(`UPDATE product_variants SET stock = stock + ?2, updated_at = datetime('now') WHERE id = ?1`)
        .bind(item.variant_id, quantity)
    );
    statements.push(
      db()
        .prepare(
          `INSERT INTO inventory_movements (id, variant_id, delta, reason, order_id, note, actor_email)
           VALUES (?1, ?2, ?3, 'refund_restock', ?4, 'full refund', ?5)`
        )
        .bind(`inv_${randomToken(10)}`, item.variant_id, quantity, orderId, actor?.email ?? '')
    );
  }
  if (statements.length) await db().batch(statements);
}

/** Move the order to `refunded` once nothing is left to refund. */
async function settleOrderAfterRefund(orderId: string): Promise<void> {
  const remaining = await refundableMinor(orderId);
  if (remaining > 0) return;
  const order = await findOrderById(orderId);
  if (!order || order.status === 'refunded') return;
  await db()
    .prepare(
      `UPDATE orders SET status = 'refunded', payment_status = 'refunded', updated_at = datetime('now') WHERE id = ?1`
    )
    .bind(orderId)
    .run();
}

export async function totalsRefunded(limit = 100): Promise<number> {
  const row = await db()
    .prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS n FROM refunds WHERE status = 'completed' LIMIT ?1`)
    .bind(limit)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
