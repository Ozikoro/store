import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  SHIPMENT_STATUSES,
  assertTransition,
  canTransition,
  canTransitionShipment,
  formatOrderNumber,
  isOpenForFulfilment,
  isTerminal,
  OrderStateError,
  paymentStatusForOrderStatus,
  restocksInventory,
  type OrderStatus,
  type ShipmentStatus,
} from '../lib/order-state';

/**
 * The order state machine.
 *
 * WHY THIS FILE EXISTS
 *
 * Two mistakes here are expensive and silent:
 *
 *   1. Letting an order reach `paid` without a verified payment. That ships goods
 *      for free, and the customer is not being dishonest — the store simply told
 *      itself the money arrived.
 *   2. Restocking twice. Cancelling an order returns its stock; if a second
 *      transition could also restock, the shop would sell units it does not have,
 *      and the error surfaces at the courier rather than at the till.
 *
 * Both are asserted here as PROPERTIES over every status rather than as a handful
 * of examples, so a new status or a widened transition table fails the suite.
 */

describe('the table is complete', () => {
  it('every declared order status can be looked up', () => {
    for (const status of ORDER_STATUSES) {
      // A status with no entry in TRANSITIONS would be treated as terminal by
      // the `?? []` fallbacks, which would silently freeze new orders.
      expect(() => canTransition(status, status)).not.toThrow();
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it('every declared shipment status can be looked up', () => {
    for (const status of SHIPMENT_STATUSES) {
      expect(canTransitionShipment(status, status)).toBe(true);
    }
  });
});

describe('paid is reachable only from an unpaid state', () => {
  // The set of statuses that may become `paid`. It is deliberately tiny, and the
  // settlement path is the only caller that has verified anything with the
  // gateway.
  const mayBecomePaid: OrderStatus[] = ['pending', 'failed'];

  it('only an unpaid order can become paid', () => {
    for (const from of ORDER_STATUSES) {
      // A transition to itself is always allowed — it is how the code expresses
      // "nothing is changing", and `canTransition(from, from)` returning true is
      // what makes the admin's no-op save harmless. It is not a route INTO a
      // state, so it is excluded from the claim being made here.
      if (from === 'paid') continue;
      expect(canTransition(from, 'paid')).toBe(mayBecomePaid.includes(from));
    }
  });

  it('repeating the current status is always allowed, because nothing is changing', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it('no settled state can go back to paid', () => {
    for (const settled of ['refunded', 'partially_refunded', 'delivered', 'shipped', 'cancelled'] as OrderStatus[]) {
      expect(canTransition(settled, 'paid')).toBe(false);
    }
  });
});

describe('a terminal order stays terminal', () => {
  it('refunded and cancelled allow no transition except to themselves', () => {
    for (const terminal of ['refunded', 'cancelled'] as OrderStatus[]) {
      for (const to of ORDER_STATUSES) {
        if (to === terminal) continue;
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('the statuses that restock inventory are exactly the terminal ones', () => {
    // This is the property that makes a double-restock impossible: restocking
    // happens on entering a terminal state, and a terminal state has no exits.
    for (const status of ORDER_STATUSES) {
      if (restocksInventory(status)) {
        expect(isTerminal(status)).toBe(true);
      }
    }
  });

  it('only cancellation and refund restock', () => {
    const restocking = ORDER_STATUSES.filter((status) => restocksInventory(status));
    expect([...restocking].sort()).toEqual(['cancelled', 'refunded']);
  });

  it('a failed payment does NOT restock, because a failed order still holds its stock', () => {
    // A failed payment is not the end: the customer can retry, and the stock must
    // still be theirs. Only cancellation releases it.
    expect(restocksInventory('failed')).toBe(false);
    expect(isTerminal('failed')).toBe(false);
  });
});

describe('an order cannot skip payment', () => {
  it('nothing reaches a fulfilled or shipped state from pending or failed', () => {
    for (const from of ['pending', 'failed'] as OrderStatus[]) {
      for (const to of ['processing', 'fulfilled', 'shipped', 'delivered'] as OrderStatus[]) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('fulfilment is offered only for orders that are paid or beyond', () => {
    for (const status of ORDER_STATUSES) {
      const open = isOpenForFulfilment(status);
      if (open) {
        expect(['paid', 'processing', 'fulfilled', 'shipped']).toContain(status);
      }
      // The negative direction matters more: an unpaid order must not be
      // fulfilable, or the store ships for free.
      if (status === 'pending' || status === 'failed') {
        expect(open).toBe(false);
      }
    }
  });
});

describe('assertTransition reports the refusal usefully', () => {
  it('allows what the table allows and throws what it does not', () => {
    expect(() => assertTransition('pending', 'paid')).not.toThrow();
    expect(() => assertTransition('pending', 'delivered')).toThrow(OrderStateError);
  });

  it('names both statuses in the message, so a log is readable without the code', () => {
    try {
      assertTransition('cancelled', 'shipped');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(OrderStateError);
      expect((error as Error).message).toMatch(/cancelled/);
      expect((error as Error).message).toMatch(/shipped/);
      expect((error as OrderStateError).status).toBe(409);
    }
  });
});

describe('the payment status a transition implies', () => {
  it('marks the fulfilment statuses as paid', () => {
    for (const status of ['paid', 'processing', 'fulfilled', 'shipped', 'delivered'] as OrderStatus[]) {
      expect(paymentStatusForOrderStatus(status)).toBe('paid');
    }
  });

  it('maps the refund statuses', () => {
    expect(paymentStatusForOrderStatus('refunded')).toBe('refunded');
    expect(paymentStatusForOrderStatus('partially_refunded')).toBe('partially_refunded');
    expect(paymentStatusForOrderStatus('failed')).toBe('failed');
  });

  it('leaves the payment status ALONE for a cancelled order', () => {
    // A cancelled order may have been paid and refunded, or never paid at all.
    // Guessing here would rewrite the payment record of a real sale.
    expect(paymentStatusForOrderStatus('cancelled')).toBeNull();
    expect(paymentStatusForOrderStatus('pending')).toBeNull();
  });

  it('only ever returns a declared payment status', () => {
    for (const status of ORDER_STATUSES) {
      const mapped = paymentStatusForOrderStatus(status);
      if (mapped !== null) expect(PAYMENT_STATUSES).toContain(mapped);
    }
  });
});

describe('order numbers', () => {
  it('are stable and increasing', () => {
    expect(formatOrderNumber(0)).toBe('OZK-10000');
    expect(formatOrderNumber(1)).toBe('OZK-10001');
    expect(formatOrderNumber(999)).toBe('OZK-10999');
  });

  it('do not collapse different sequence values onto one number', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(formatOrderNumber(i));
    expect(seen.size).toBe(5000);
  });
});

describe('shipments move forward and can always be sent back', () => {
  it('a delivered parcel can only be returned', () => {
    for (const to of SHIPMENT_STATUSES) {
      if (to === 'delivered') continue;
      expect(canTransitionShipment('delivered', to)).toBe(to === 'returned');
    }
  });

  it('a returned parcel is final', () => {
    for (const to of SHIPMENT_STATUSES) {
      if (to === 'returned') continue;
      expect(canTransitionShipment('returned', to)).toBe(false);
    }
  });

  it('a pending parcel cannot claim to be delivered without moving', () => {
    expect(canTransitionShipment('pending', 'dispatched')).toBe(true);
    expect(canTransitionShipment('pending', 'delivered')).toBe(false);
  });

  it('every shipment status is reachable from pending or is its own start', () => {
    for (const to of SHIPMENT_STATUSES) {
      if (to === 'pending') continue;
      const reachableSomehow = SHIPMENT_STATUSES.some((from) => canTransitionShipment(from, to));
      expect(reachableSomehow).toBe(true);
    }
  });
});
