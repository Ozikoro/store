/**
 * Order state.
 *
 * The state machine is defined here as data, once, so that the admin UI, the
 * fulfilment actions and the tests all read the same rules. The two properties
 * that matter:
 *
 *   1. An order becomes `paid` only through the payment-verification path. No
 *      admin action, no webhook parsing bug and no client request can set
 *      `paid_at` — only `settlePayment` does.
 *   2. A cancelled or refunded order puts stock back exactly once. Transitions
 *      that would double-refund inventory are not in the table.
 *
 * `payment_status` and `fulfilment_status` are tracked separately from the
 * customer-facing `status`, because "paid and not yet shipped" is two facts and
 * collapsing them into one column is how a store marks something sent that was
 * never paid for.
 */

export const ORDER_STATUSES = [
  'pending',
  'paid',
  'processing',
  'fulfilled',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
  'failed',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ['unpaid', 'paid', 'failed', 'refunded', 'partially_refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const FULFILMENT_STATUSES = ['unfulfilled', 'partial', 'fulfilled', 'returned'] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

/**
 * Allowed order-status transitions.
 *
 * `paid` is absent as a target from everything except `pending` and `failed`,
 * and even there the transition is performed by the settlement path, which is
 * the only caller that has verified a payment with the gateway.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ['paid', 'failed', 'cancelled'],
  failed: ['pending', 'cancelled', 'paid'],
  paid: ['processing', 'cancelled', 'refunded', 'partially_refunded', 'fulfilled', 'shipped'],
  processing: ['fulfilled', 'shipped', 'delivered', 'cancelled', 'refunded', 'partially_refunded'],
  fulfilled: ['shipped', 'delivered', 'refunded', 'partially_refunded'],
  shipped: ['delivered', 'refunded', 'partially_refunded'],
  delivered: ['refunded', 'partially_refunded'],
  partially_refunded: ['refunded', 'delivered', 'shipped', 'fulfilled'],
  refunded: [],
  cancelled: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class OrderStateError extends Error {
  readonly status = 409;
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`An order that is ${from} cannot become ${to}.`);
    this.name = 'OrderStateError';
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new OrderStateError(from, to);
}

/**
 * Whether moving into this status should return reserved stock to the shelf.
 *
 * Only the two genuinely terminal states do it, and both are terminal in the
 * transition table above, so a double-restock is impossible: once the order is
 * `cancelled` it has no further transitions.
 */
export function restocksInventory(to: OrderStatus): boolean {
  return to === 'cancelled' || to === 'refunded';
}

export function isOpenForFulfilment(status: OrderStatus): boolean {
  return status === 'paid' || status === 'processing' || status === 'fulfilled' || status === 'shipped';
}

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status]?.length === 0;
}

export function paymentStatusForOrderStatus(status: OrderStatus): PaymentStatus | null {
  switch (status) {
    case 'paid':
    case 'processing':
    case 'fulfilled':
    case 'shipped':
    case 'delivered':
      return 'paid';
    case 'refunded':
      return 'refunded';
    case 'partially_refunded':
      return 'partially_refunded';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'cancelled':
      return null; // unchanged: a cancelled unpaid order was never paid
    default:
      return null;
  }
}

/** Human-facing labels. Kept here so the admin and the receipt agree. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Awaiting payment',
  paid: 'Paid',
  processing: 'Processing',
  fulfilled: 'Packed',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partially_refunded: 'Partly refunded',
  failed: 'Payment failed',
};

/**
 * A customer-facing order number.
 *
 * `OZK-` plus an increasing counter. The number is what a customer quotes and
 * what appears on a courier label, so it must be stable and unique — the
 * UNIQUE constraint on `orders.number` is what actually guarantees that, and
 * this merely proposes a value.
 */
export function formatOrderNumber(sequence: number): string {
  return `OZK-${String(10000 + sequence)}`;
}

/**
 * The order in which a shipment's tracking should be readable.
 *
 * These are transitions for a shipment, not an order: an order can be delivered
 * while a second shipment is still pending, which is what partial fulfilment
 * means.
 */
export const SHIPMENT_STATUSES = ['pending', 'dispatched', 'in_transit', 'delivered', 'returned'] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  pending: ['dispatched', 'returned'],
  dispatched: ['in_transit', 'delivered', 'returned'],
  in_transit: ['delivered', 'returned'],
  delivered: ['returned'],
  returned: [],
};

export function canTransitionShipment(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return from === to || (SHIPMENT_TRANSITIONS[from] ?? []).includes(to);
}
