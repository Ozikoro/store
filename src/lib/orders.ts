/**
 * Order and payment persistence.
 *
 * Every function that touches money is written so that repeating it changes
 * nothing. A webhook can arrive twice, a customer can refresh the callback page,
 * and Paystack retries non-2xx responses — none of those may produce a second
 * confirmed order, a second stock decrement, or a second refund.
 */

import { db } from './env';
import { randomToken, shortId } from './crypto';
import { recordAudit, type AuditActor } from './audit';
import {
  assertTransition,
  formatOrderNumber,
  paymentStatusForOrderStatus,
  restocksInventory,
  type OrderStatus,
  type PaymentStatus,
  type FulfilmentStatus,
} from './order-state';

export interface OrderRow {
  id: string;
  number: string;
  customer_id: string | null;
  email: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  fulfilment_status: FulfilmentStatus;
  currency: string;
  subtotal_minor: number;
  discount_minor: number;
  shipping_minor: number;
  tax_minor: number;
  total_minor: number;
  discount_code: string;
  shipping_method: string;
  shipping_address: string;
  billing_address: string;
  customer_note: string;
  admin_note: string;
  paid_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string | null;
  variant_id: string | null;
  product_slug: string;
  title: string;
  variant_title: string;
  sku: string;
  image_url: string;
  unit_price_minor: number;
  quantity: number;
  line_total_minor: number;
  quantity_fulfilled: number;
  quantity_refunded: number;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  provider: string;
  reference: string;
  provider_reference: string | null;
  amount_minor: number;
  currency: string;
  status: 'initialized' | 'pending' | 'success' | 'failed' | 'abandoned' | 'reversed';
  channel: string | null;
  gateway_response: string | null;
  settled_at: string | null;
  verified_at: string | null;
  raw: string;
  created_at: string;
  updated_at: string;
}

/** A reference we generate, and the only thing we later ask Paystack about. */
export function newPaymentReference(): string {
  return `OZK-${Date.now().toString(36).toUpperCase()}-${shortId(6)}`;
}

/** Propose the next order number. Uniqueness is enforced by the database. */
export async function nextOrderNumber(): Promise<string> {
  const row = await db()
    .prepare('SELECT COUNT(*) AS n FROM orders')
    .first<{ n: number }>();
  const sequence = (row?.n ?? 0) + 1;
  const candidate = formatOrderNumber(sequence);
  const clash = await db()
    .prepare('SELECT 1 AS x FROM orders WHERE number = ?1')
    .bind(candidate)
    .first<{ x: number }>();
  // A deleted order can free a number; appending entropy keeps the UNIQUE
  // constraint from turning that into a failed checkout.
  return clash ? `${candidate}-${shortId(3)}` : candidate;
}

// ------------------------------------------------------------------ reads

export async function findOrderById(id: string): Promise<OrderRow | null> {
  return db().prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first<OrderRow>();
}

export async function findOrderByNumber(number: string): Promise<OrderRow | null> {
  return db().prepare('SELECT * FROM orders WHERE number = ?1').bind(number).first<OrderRow>();
}

export async function findOrderByReference(reference: string): Promise<OrderRow | null> {
  const row = await db()
    .prepare(
      `SELECT o.* FROM orders o
         JOIN payments p ON p.order_id = o.id
        WHERE p.reference = ?1`
    )
    .bind(reference)
    .first<OrderRow>();
  return row;
}

export async function orderItems(orderId: string): Promise<OrderItemRow[]> {
  const result = await db()
    .prepare('SELECT * FROM order_items WHERE order_id = ?1 ORDER BY rowid')
    .bind(orderId)
    .all<OrderItemRow>();
  return result.results ?? [];
}

export async function ordersForCustomer(customerId: string): Promise<OrderRow[]> {
  const result = await db()
    .prepare('SELECT * FROM orders WHERE customer_id = ?1 ORDER BY created_at DESC')
    .bind(customerId)
    .all<OrderRow>();
  return result.results ?? [];
}

/**
 * Orders for an email address.
 *
 * Guest checkout means an order may exist with no customer row at all, so the
 * address is the second key. This is what lets someone who bought as a guest
 * then register and still see the purchase.
 */
export async function ordersForEmail(email: string): Promise<OrderRow[]> {
  const result = await db()
    .prepare('SELECT * FROM orders WHERE email = ?1 COLLATE NOCASE ORDER BY created_at DESC')
    .bind(email.trim().toLowerCase())
    .all<OrderRow>();
  return result.results ?? [];
}

export async function paymentsForOrder(orderId: string): Promise<PaymentRow[]> {
  const result = await db()
    .prepare('SELECT * FROM payments WHERE order_id = ?1 ORDER BY created_at DESC')
    .bind(orderId)
    .all<PaymentRow>();
  return result.results ?? [];
}

export async function findPaymentByReference(reference: string): Promise<PaymentRow | null> {
  return db().prepare('SELECT * FROM payments WHERE reference = ?1').bind(reference).first<PaymentRow>();
}

export async function findPaymentByProviderReference(providerReference: string): Promise<PaymentRow | null> {
  return db()
    .prepare('SELECT * FROM payments WHERE provider_reference = ?1')
    .bind(providerReference)
    .first<PaymentRow>();
}

export interface ShipmentRow {
  id: string;
  order_id: string;
  carrier: string;
  tracking_number: string;
  tracking_url: string;
  status: string;
  shipped_at: string | null;
  delivered_at: string | null;
  note: string;
  created_at: string;
  updated_at: string;
}

export async function shipmentsForOrder(orderId: string): Promise<ShipmentRow[]> {
  const result = await db()
    .prepare('SELECT * FROM shipments WHERE order_id = ?1 ORDER BY created_at')
    .bind(orderId)
    .all<ShipmentRow>();
  return result.results ?? [];
}

// ----------------------------------------------------------------- writes

export interface CreateOrderInput {
  customerId: string | null;
  email: string;
  currency: string;
  lines: Array<{
    productId: string | null;
    variantId: string | null;
    productSlug: string;
    title: string;
    variantTitle: string;
    sku: string;
    imageUrl: string;
    unitPriceMinor: number;
    quantity: number;
  }>;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  taxMinor: number;
  totalMinor: number;
  discountCode: string;
  shippingMethod: string;
  shippingAddress: Record<string, unknown>;
  billingAddress: Record<string, unknown>;
  customerNote: string;
}

/**
 * Create a pending order and its lines, and reserve stock.
 *
 * Stock is decremented HERE, at order creation, not at payment. The reason is
 * the handoff's "out-of-stock cannot be purchased accidentally": between
 * initialising a payment and the customer finishing it, minutes pass, and if
 * stock were only taken at payment two customers could both be sold the last
 * item. Reserving at creation means the second customer is told before they pay.
 *
 * The cost is that an abandoned checkout holds stock. That is why a pending order
 * that never settles can be cancelled (returning the stock) and why the admin
 * dashboard surfaces pending orders.
 */
export async function createPendingOrder(input: CreateOrderInput): Promise<OrderRow> {
  const id = `ord_${randomToken(12)}`;
  const number = await nextOrderNumber();

  const statements = [
    db()
      .prepare(
        `INSERT INTO orders (
           id, number, customer_id, email, status, payment_status, fulfilment_status, currency,
           subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor,
           discount_code, shipping_method, shipping_address, billing_address, customer_note
         ) VALUES (?1,?2,?3,?4,'pending','unpaid','unfulfilled',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)`
      )
      .bind(
        id,
        number,
        input.customerId,
        input.email.trim().toLowerCase(),
        input.currency,
        input.subtotalMinor,
        input.discountMinor,
        input.shippingMinor,
        input.taxMinor,
        input.totalMinor,
        input.discountCode,
        input.shippingMethod,
        JSON.stringify(input.shippingAddress ?? {}),
        JSON.stringify(input.billingAddress ?? {}),
        input.customerNote.slice(0, 2000)
      ),
  ];

  for (const line of input.lines) {
    statements.push(
      db()
        .prepare(
          `INSERT INTO order_items (
             id, order_id, product_id, variant_id, product_slug, title, variant_title,
             sku, image_url, unit_price_minor, quantity, line_total_minor
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
        )
        .bind(
          `oit_${randomToken(10)}`,
          id,
          line.productId,
          line.variantId,
          line.productSlug,
          line.title,
          line.variantTitle,
          line.sku,
          line.imageUrl,
          line.unitPriceMinor,
          line.quantity,
          line.unitPriceMinor * line.quantity
        )
    );
    // The conditional decrement is the guard: if the UPDATE matches no row the
    // stock ran out between the check and the write, and the batch is rolled
    // back by the caller.
    statements.push(
      db()
        .prepare(
          `UPDATE product_variants
              SET stock = stock - ?2, updated_at = datetime('now')
            WHERE id = ?1 AND stock >= ?2`
        )
        .bind(line.variantId, line.quantity)
    );
    statements.push(
      db()
        .prepare(
          `INSERT INTO inventory_movements (id, variant_id, delta, reason, order_id, note)
           VALUES (?1, ?2, ?3, 'order_placed', ?4, ?5)`
        )
        .bind(`inv_${randomToken(10)}`, line.variantId, -line.quantity, id, number)
    );
  }

  await db().batch(statements);

  const created = await findOrderById(id);
  if (!created) throw new Error('Order was not created');
  return created;
}

/** Attach an initialised payment to an order. Idempotent on the reference. */
export async function createPayment(input: {
  orderId: string;
  reference: string;
  amountMinor: number;
  currency: string;
}): Promise<PaymentRow> {
  const existing = await findPaymentByReference(input.reference);
  if (existing) return existing;

  const id = `pay_${randomToken(12)}`;
  await db()
    .prepare(
      `INSERT INTO payments (id, order_id, provider, reference, amount_minor, currency, status)
       VALUES (?1, ?2, 'paystack', ?3, ?4, ?5, 'initialized')`
    )
    .bind(id, input.orderId, input.reference, input.amountMinor, input.currency)
    .run();
  const row = await findPaymentByReference(input.reference);
  if (!row) throw new Error('Payment was not created');
  return row;
}

export async function markPaymentInitialized(reference: string, authorizationUrl?: string): Promise<void> {
  await db()
    .prepare(
      `UPDATE payments
          SET status = CASE WHEN status = 'initialized' THEN 'pending' ELSE status END,
              raw = CASE WHEN ?2 = '' THEN raw ELSE json_set(COALESCE(NULLIF(raw,''),'{}'), '$.authorization_url', ?2) END,
              updated_at = datetime('now')
        WHERE reference = ?1`
    )
    .bind(reference, authorizationUrl ?? '')
    .run();
}

export interface SettlementResult {
  /** False when this call found the payment already settled. */
  changed: boolean;
  order: OrderRow | null;
}

/**
 * Settle a payment. THIS IS THE ONLY FUNCTION THAT MAY MARK AN ORDER PAID.
 *
 * The caller must have independently verified the transaction with the gateway
 * (either the webhook handler or the callback handler, both of which call
 * `verifyTransaction`) and must pass the amount the gateway reported. That amount
 * is compared against what the order was for, here, before anything changes —
 * a customer cannot pay ₦100 for a ₦200,000 carving and have it counted.
 *
 * Idempotency is threefold: the payment row's `settled_at` is checked, the SQL
 * only matches rows that are not already `success`, and the order transition is
 * only applied when the status actually differs.
 */
export async function settlePayment(input: {
  reference: string;
  amountMinor: number;
  currency: string;
  providerReference?: string | null;
  channel?: string | null;
  gatewayResponse?: string | null;
  raw?: unknown;
}): Promise<SettlementResult> {
  const payment = await findPaymentByReference(input.reference);
  if (!payment) return { changed: false, order: null };

  const order = await findOrderById(payment.order_id);
  if (!order) return { changed: false, order: null };

  if (payment.settled_at && payment.status === 'success') {
    return { changed: false, order };
  }

  // The amount check. Minor units on both sides, compared exactly.
  if (input.amountMinor !== order.total_minor) {
    await db()
      .prepare(
        `UPDATE payments
            SET status = 'failed',
                gateway_response = ?2,
                raw = ?3,
                verified_at = datetime('now'),
                updated_at = datetime('now')
          WHERE reference = ?1 AND settled_at IS NULL`
      )
      .bind(
        input.reference,
        `Amount mismatch: gateway reported ${input.amountMinor} ${input.currency}, order is ${order.total_minor} ${order.currency}`,
        JSON.stringify(input.raw ?? {})
      )
      .run();
    return { changed: false, order };
  }

  const updated = await db()
    .prepare(
      `UPDATE payments
          SET status = 'success',
              provider_reference = COALESCE(?2, provider_reference),
              channel = COALESCE(?3, channel),
              gateway_response = COALESCE(?4, gateway_response),
              settled_at = COALESCE(settled_at, datetime('now')),
              verified_at = datetime('now'),
              raw = ?5,
              updated_at = datetime('now')
        WHERE reference = ?1 AND status != 'success'`
    )
    .bind(
      input.reference,
      input.providerReference ?? null,
      input.channel ?? null,
      input.gatewayResponse ?? null,
      JSON.stringify(input.raw ?? {})
    )
    .run();

  if (!updated.meta || (updated.meta['changes'] as number) === 0) {
    // Another isolate settled it between our read and our write. Nothing to do.
    return { changed: false, order: await findOrderById(payment.order_id) };
  }

  const nextStatus: OrderStatus = order.status === 'pending' || order.status === 'failed' ? 'paid' : order.status;
  await db()
    .prepare(
      `UPDATE orders
          SET status = ?2,
              payment_status = 'paid',
              paid_at = COALESCE(paid_at, datetime('now')),
              updated_at = datetime('now')
        WHERE id = ?1`
    )
    .bind(order.id, nextStatus)
    .run();

  await recordAudit({
    actor: null,
    action: 'order.paid',
    entity: 'order',
    entityId: order.id,
    before: { status: order.status, payment_status: order.payment_status },
    after: { status: nextStatus, payment_status: 'paid', reference: input.reference },
  });

  return { changed: true, order: await findOrderById(order.id) };
}

/**
 * Record that the gateway has taken a refund back out of the payments table.
 *
 * A refund does not change what the customer paid, but it does change what the
 * business is holding, and the dashboard reads `payment_status`. Called once a
 * refund is genuinely SETTLED at the gateway — not when the request is accepted,
 * because between those two moments the money may still fail to arrive and the
 * payment must keep saying `paid`.
 */
export async function markPaymentRefunded(orderId: string): Promise<void> {
  await db()
    .prepare(
      `UPDATE payments
          SET status = 'refunded', updated_at = datetime('now')
        WHERE order_id = ?1 AND settled_at IS NOT NULL AND status = 'success'`
    )
    .bind(orderId)
    .run();
}

export async function markPaymentFailed(reference: string, reason: string, raw?: unknown): Promise<void> {
  await db()
    .prepare(
      `UPDATE payments
          SET status = 'failed', gateway_response = ?2, raw = ?3,
              verified_at = datetime('now'), updated_at = datetime('now')
        WHERE reference = ?1 AND settled_at IS NULL AND status != 'success'`
    )
    .bind(reference, reason, JSON.stringify(raw ?? {}))
    .run();
}

export class OrderWriteError extends Error {
  readonly status = 409;
}

/**
 * Change an order's status, with the state machine enforced and inventory
 * returned when the change ends the order.
 */
export async function updateOrderStatus(input: {
  orderId: string;
  to: OrderStatus;
  actor: AuditActor | null;
  note?: string;
}): Promise<OrderRow> {
  const order = await findOrderById(input.orderId);
  if (!order) throw new OrderWriteError('Order not found.');

  assertTransition(order.status, input.to);

  const paymentStatus = paymentStatusForOrderStatus(input.to);
  await db()
    .prepare(
      `UPDATE orders
          SET status = ?2,
              payment_status = COALESCE(?3, payment_status),
              cancelled_at = CASE WHEN ?2 = 'cancelled' THEN datetime('now') ELSE cancelled_at END,
              admin_note = CASE WHEN ?4 = '' THEN admin_note ELSE ?4 END,
              updated_at = datetime('now')
        WHERE id = ?1`
    )
    .bind(order.id, input.to, paymentStatus, input.note ?? '')
    .run();

  if (restocksInventory(input.to)) {
    await returnOrderStock(order.id, input.to, input.actor);
  }

  await recordAudit({
    actor: input.actor,
    action: `order.status_changed`,
    entity: 'order',
    entityId: order.id,
    before: { status: order.status, payment_status: order.payment_status },
    after: { status: input.to, note: input.note ?? '' },
  });

  const updated = await findOrderById(order.id);
  if (!updated) throw new OrderWriteError('Order disappeared during update.');
  return updated;
}

/**
 * Put an ended order's stock back, exactly once.
 *
 * Guarded by the inventory ledger rather than by a flag: if a movement with
 * reason `order_cancelled` (or `refund_restock`) already exists for this order,
 * nothing happens. The ledger is the record, so the guard cannot drift from it.
 */
export async function returnOrderStock(
  orderId: string,
  reason: OrderStatus,
  actor: AuditActor | null
): Promise<number> {
  const movementReason = reason === 'refunded' ? 'refund_restock' : 'order_cancelled';
  const already = await db()
    .prepare('SELECT COUNT(*) AS n FROM inventory_movements WHERE order_id = ?1 AND reason = ?2')
    .bind(orderId, movementReason)
    .first<{ n: number }>();
  if ((already?.n ?? 0) > 0) return 0;

  const items = await orderItems(orderId);
  const statements = [];
  let restored = 0;
  for (const item of items) {
    if (!item.variant_id) continue;
    const quantity = item.quantity - item.quantity_refunded;
    if (quantity <= 0) continue;
    restored += quantity;
    statements.push(
      db()
        .prepare(
          `UPDATE product_variants SET stock = stock + ?2, updated_at = datetime('now') WHERE id = ?1`
        )
        .bind(item.variant_id, quantity)
    );
    statements.push(
      db()
        .prepare(
          `INSERT INTO inventory_movements (id, variant_id, delta, reason, order_id, note, actor_email)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .bind(
          `inv_${randomToken(10)}`,
          item.variant_id,
          quantity,
          movementReason,
          orderId,
          reason,
          actor?.email ?? ''
        )
    );
  }
  if (statements.length) await db().batch(statements);
  return restored;
}

export async function setOrderAdminNote(orderId: string, note: string): Promise<void> {
  await db()
    .prepare(`UPDATE orders SET admin_note = ?2, updated_at = datetime('now') WHERE id = ?1`)
    .bind(orderId, note.slice(0, 4000))
    .run();
}

export async function updateFulfilmentStatus(orderId: string, status: FulfilmentStatus): Promise<void> {
  await db()
    .prepare(`UPDATE orders SET fulfilment_status = ?2, updated_at = datetime('now') WHERE id = ?1`)
    .bind(orderId, status)
    .run();
}

export async function markItemsFulfilled(orderId: string, itemId: string, quantity: number): Promise<void> {
  await db()
    .prepare(
      `UPDATE order_items
          SET quantity_fulfilled = MIN(quantity, quantity_fulfilled + ?3)
        WHERE id = ?2 AND order_id = ?1`
    )
    .bind(orderId, itemId, quantity)
    .run();

  const remaining = await db()
    .prepare(
      `SELECT SUM(quantity - quantity_fulfilled) AS outstanding FROM order_items WHERE order_id = ?1`
    )
    .bind(orderId)
    .first<{ outstanding: number | null }>();

  const fulfilled: FulfilmentStatus = (remaining?.outstanding ?? 0) > 0 ? 'partial' : 'fulfilled';
  await updateFulfilmentStatus(orderId, fulfilled);
}

export interface CreateShipmentInput {
  orderId: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl?: string;
  note?: string;
  actor: AuditActor | null;
}

export async function createShipment(input: CreateShipmentInput): Promise<ShipmentRow> {
  const id = `shp_${randomToken(12)}`;
  await db()
    .prepare(
      `INSERT INTO shipments (id, order_id, carrier, tracking_number, tracking_url, status, shipped_at, note)
       VALUES (?1, ?2, ?3, ?4, ?5, 'dispatched', datetime('now'), ?6)`
    )
    .bind(
      id,
      input.orderId,
      input.carrier.slice(0, 120),
      input.trackingNumber.slice(0, 120),
      (input.trackingUrl ?? '').slice(0, 500),
      (input.note ?? '').slice(0, 2000)
    )
    .run();

  await recordAudit({
    actor: input.actor,
    action: 'shipment.created',
    entity: 'shipment',
    entityId: id,
    after: { orderId: input.orderId, carrier: input.carrier, trackingNumber: input.trackingNumber },
  });

  const row = await db().prepare('SELECT * FROM shipments WHERE id = ?1').bind(id).first<ShipmentRow>();
  if (!row) throw new OrderWriteError('Shipment was not created.');
  return row;
}

export async function updateShipmentStatus(
  shipmentId: string,
  status: string,
  actor: AuditActor | null
): Promise<void> {
  await db()
    .prepare(
      `UPDATE shipments
          SET status = ?2,
              delivered_at = CASE WHEN ?2 = 'delivered' THEN datetime('now') ELSE delivered_at END,
              updated_at = datetime('now')
        WHERE id = ?1`
    )
    .bind(shipmentId, status)
    .run();
  await recordAudit({
    actor,
    action: 'shipment.status_changed',
    entity: 'shipment',
    entityId: shipmentId,
    after: { status },
  });
}

/** Every order for the admin list, newest first, with a lightweight filter. */
export async function listOrders(input: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ orders: OrderRow[]; total: number }> {
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  const offset = Math.max(0, input.offset ?? 0);
  const clauses: string[] = [];
  const bindings: unknown[] = [];

  if (input.status && input.status !== 'all') {
    bindings.push(input.status);
    clauses.push(`status = ?${bindings.length}`);
  }
  if (input.search && input.search.trim()) {
    bindings.push(`%${input.search.trim().toLowerCase()}%`);
    const index = bindings.length;
    clauses.push(`(LOWER(number) LIKE ?${index} OR LOWER(email) LIKE ?${index})`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const countRow = await db()
    .prepare(`SELECT COUNT(*) AS n FROM orders ${where}`)
    .bind(...bindings)
    .first<{ n: number }>();

  const rows = await db()
    .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`)
    .bind(...bindings, limit, offset)
    .all<OrderRow>();

  return { orders: rows.results ?? [], total: countRow?.n ?? 0 };
}
