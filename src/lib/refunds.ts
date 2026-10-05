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
import { refundTransaction, verifyRefund } from './paystack';
import { orderItems, findOrderById, markPaymentRefunded, paymentsForOrder } from './orders';

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
    await releaseFailedRefund(refundId, 'No settled payment to refund against.', actor);
    throw new RefundError('This order has no settled payment to refund against.');
  }

  const result = await refundTransaction({
    providerReference: settled.provider_reference,
    amountMinor: refund.amount_minor,
  });

  if (!result.ok) {
    await releaseFailedRefund(refundId, result.message, actor);
    throw new RefundError(result.message);
  }

  // THE STATUS PAYSTACK RETURNS IS NOT ALWAYS `completed`. A refund it accepts
  // and settles later comes back as `processing`, and the first version of this
  // function ignored that: it marked the refund `completed` and restocked the
  // goods the moment the API returned, then the webhook ignored `refund.failed`.
  // A refund that later failed left the customer recorded as refunded and the
  // stock back on the shelf, having returned no money.
  //
  // So the row is marked completed only when the gateway says it is, and
  // otherwise stays `processing` — which `refundableMinor` already counts as
  // spent, so the customer cannot be refunded twice while it is in flight.
  const settledNow = result.status === 'completed' || result.status === 'success';
  await db()
    .prepare(
      `UPDATE refunds
          SET status = ?3, provider_reference = ?2, updated_at = datetime('now')
        WHERE id = ?1`
    )
    .bind(refundId, result.providerReference ?? settled.provider_reference, settledNow ? 'completed' : 'processing')
    .run();

  /*
   * THE GOODS AND THE ORDER ONLY MOVE ONCE THE MONEY HAS.
   *
   * When Paystack settles a refund immediately, everything finalises here. When
   * it does not, the refund is left `processing` and the webhook finishes the
   * job — see `settleRefund`, which the `refund.processed` delivery calls. Until
   * then the order still says `partially_refunded` and the stock stays reserved,
   * because the customer has not been paid back yet.
   */
  if (settledNow) {
    await settleRefund(refundId, actor);
  } else {
    // Accepted, not settled. Ask the gateway once more immediately: many refunds
    // complete within the first second, and settling here means the common case
    // does not depend on a webhook that this account may deliver elsewhere.
    const checked = result.providerReference ? await verifyRefund(result.providerReference) : { ok: false as const, message: 'no reference' };
    if (checked.ok && checked.status === 'completed') {
      await settleRefund(refundId, actor);
    } else if (checked.ok && checked.status === 'failed') {
      await releaseFailedRefund(refundId, 'The gateway reports the refund failed.', actor);
    } else {
      await recordAudit({
        actor,
        action: 'refund.processing',
        entity: 'refund',
        entityId: refundId,
        after: {
          amountMinor: refund.amount_minor,
          orderId: refund.order_id,
          gatewayStatus: result.status,
          verified: checked.ok ? checked.status : checked.message,
        },
      });
    }
  }

  const updated = await db().prepare('SELECT * FROM refunds WHERE id = ?1').bind(refundId).first<RefundRow>();
  if (!updated) throw new RefundError('Refund disappeared during execution.');
  return updated;
}

/**
 * Finish a refund the gateway has settled.
 *
 * Split out of `executeRefund` because it has two callers: the synchronous path,
 * when Paystack settles before answering, and the webhook, when the money lands
 * later. Both must do exactly the same three things, or a refund would restock on
 * one path and not the other.
 *
 * Every step is idempotent. `restockRefund` is guarded by the inventory ledger,
 * `markPaymentRefunded` only touches a settled payment, and
 * `settleOrderAfterRefund` recomputes whether anything is left.
 */
export async function settleRefund(refundId: string, actor: AuditActor | null): Promise<void> {
  const refund = await db().prepare('SELECT * FROM refunds WHERE id = ?1').bind(refundId).first<RefundRow>();
  if (!refund) throw new RefundError('No such refund.');
  if (refund.status === 'failed') {
    // A refund that has already failed must never be finished by a late
    // `refund.processed` for the same provider reference. The money is the
    // gateway's to explain, and quietly restocking here would hide it.
    throw new RefundError('That refund failed and cannot be settled.');
  }

  await db()
    .prepare(`UPDATE refunds SET status = 'completed', updated_at = datetime('now') WHERE id = ?1`)
    .bind(refundId)
    .run();

  await markPaymentRefunded(refund.order_id);

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

  // The customer is told, once the refund has genuinely settled — not when it
  // was requested, which is why this is here and not in `requestRefund`.
  await queueRefundFor(refund.order_id, refund.amount_minor);
}

/** Queue the refund notice. Swallows its own failure, as the other hooks do. */
async function queueRefundFor(orderId: string, amountMinor: number): Promise<void> {
  try {
    const order = await findOrderById(orderId);
    if (!order) return;
    const { queueRefundNotice } = await import('./mail');
    await queueRefundNotice({
      number: order.number,
      email: order.email,
      customerName: '',
      amountMinor,
      currency: order.currency,
    });
  } catch (error) {
    console.error('[refunds] could not queue the refund notice for', orderId, error);
  }
}

/**
 * The gateway refused or could not complete a refund.
 *
 * The money did not move, so the order must stop claiming it did. Without this a
 * failed refund left the order `partially_refunded` with a full balance still
 * refundable — the worst of both: the operator believes money went out, and the
 * store has quietly reserved stock for it.
 */
export async function releaseFailedRefund(refundId: string, reason: string, actor: AuditActor | null): Promise<void> {
  const refund = await db().prepare('SELECT * FROM refunds WHERE id = ?1').bind(refundId).first<RefundRow>();
  if (!refund) throw new RefundError('No such refund.');
  if (refund.status === 'completed') {
    throw new RefundError('That refund is already completed; a failure cannot be recorded against it.');
  }

  await db()
    .prepare(`UPDATE refunds SET status = 'failed', reason = reason || ' — ' || ?2, updated_at = datetime('now') WHERE id = ?1`)
    .bind(refundId, reason)
    .run();

  // If nothing was ever refunded, the order goes back to `paid`. If something
  // was, it stays `partially_refunded`.
  const order = await findOrderById(refund.order_id);
  if (order && order.status === 'partially_refunded') {
    const stillRefunded = await db()
      .prepare(
        `SELECT COALESCE(SUM(amount_minor), 0) AS n FROM refunds
          WHERE order_id = ?1 AND status IN ('approved','processing','completed')`
      )
      .bind(refund.order_id)
      .first<{ n: number }>();
    if ((stillRefunded?.n ?? 0) === 0) {
      await db()
        .prepare(
          `UPDATE orders SET status = 'paid', updated_at = datetime('now') WHERE id = ?1 AND status = 'partially_refunded'`
        )
        .bind(refund.order_id)
        .run();
    }
  }

  await recordAudit({
    actor,
    action: 'refund.failed',
    entity: 'refund',
    entityId: refundId,
    after: { reason, orderId: refund.order_id, amountMinor: refund.amount_minor },
  });
}

/** The refund a provider reference belongs to, for a webhook that carries only that. */
export async function findRefundByProviderReference(providerReference: string): Promise<RefundRow | null> {
  return db()
    .prepare('SELECT * FROM refunds WHERE provider_reference = ?1 ORDER BY created_at DESC LIMIT 1')
    .bind(providerReference)
    .first<RefundRow>();
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

/**
 * Reconcile refunds the gateway has accepted but not yet settled.
 *
 * The same argument as `recheckPayment`: the webhook is not ours to rely on, so
 * an operator needs a way to ask. Called with no id it sweeps every refund still
 * in flight, which is what someone does after noticing that money left the
 * account and the order still says `partially_refunded`.
 */
export async function reconcileRefunds(
  actor: AuditActor | null,
  refundId?: string
): Promise<Array<{ id: string; orderId: string; outcome: string }>> {
  const rows = refundId
    ? await db().prepare('SELECT * FROM refunds WHERE id = ?1').bind(refundId).all<RefundRow>()
    : await db()
        .prepare(`SELECT * FROM refunds WHERE status = 'processing' ORDER BY created_at LIMIT 50`)
        .all<RefundRow>();

  const out: Array<{ id: string; orderId: string; outcome: string }> = [];
  for (const refund of rows.results ?? []) {
    if (!refund.provider_reference) {
      out.push({ id: refund.id, orderId: refund.order_id, outcome: 'no gateway reference to check' });
      continue;
    }
    const checked = await verifyRefund(refund.provider_reference);
    if (!checked.ok) {
      out.push({ id: refund.id, orderId: refund.order_id, outcome: checked.message });
      continue;
    }
    if (checked.status === 'completed') {
      await settleRefund(refund.id, actor);
      out.push({ id: refund.id, orderId: refund.order_id, outcome: 'settled' });
      continue;
    }
    if (checked.status === 'failed') {
      await releaseFailedRefund(refund.id, 'The gateway reports the refund failed.', actor);
      out.push({ id: refund.id, orderId: refund.order_id, outcome: 'released — the refund failed' });
      continue;
    }
    out.push({ id: refund.id, orderId: refund.order_id, outcome: `still ${checked.status}` });
  }
  return out;
}
