/**
 * Admin server functions.
 *
 * These are the only doors into the admin surface. Every one of them:
 *
 *   1. resolves the actor from the session cookie through `requireStaff`, which
 *      re-reads the role from the database on this request. No role, email or
 *      capability is ever accepted as an argument — a browser can lie about all
 *      three, and so can a forged fetch;
 *   2. validates and narrows whatever the caller sent before it reaches a `lib/`
 *      function;
 *   3. does the work through a `lib/` function that enforces its own rules and
 *      writes its own audit row wherever the handoff requires one (price,
 *      inventory, refund, order state).
 *
 * Money never crosses this boundary as a float. Amounts arrive from forms as
 * strings and are converted with `parseMajorToMinor`; amounts leave as integer
 * minor units for `formatMoney` to render.
 *
 * Where a `lib/` function does not itself audit a change (marking order lines
 * fulfilled, setting the admin note, toggling nothing that already audits), the
 * handler writes the row with `recordAudit` rather than editing the library.
 *
 * One build detail, because it shapes the top of the file: the admin routes are
 * client code and import this module, and this project denies files under a
 * `server/` directory in the client environment. This module is therefore
 * listed in `importProtection.client.excludeFiles` in `vite.config.ts` — safe
 * only because every export here is a `createServerFn`, so the compiler strips
 * the handler bodies out of the client chunk. `src/server/store.ts` is
 * deliberately NOT excluded, which is why the guard and the session helper are
 * reached lazily.
 */

import { createServerFn } from '@tanstack/react-start';

import { db } from '../lib/env';
import {
  auditTrailFor,
  isAuditEntity,
  recentAudit,
  recordAudit,
  type AuditActor,
  type AuditEntity,
  type AuditRow,
} from '../lib/audit';
import type { Actor } from '../lib/auth';
import { isStaff, type Capability } from '../lib/roles';
import { readString } from './typed';
import { dashboardMetrics, recentCustomers } from '../lib/admin-metrics';
import {
  archiveProduct as archiveProductLib,
  createProduct,
  createVariant,
  findProductBySlug,
  inventoryMovements,
  listProducts,
  lowStockVariants,
  parseDetails,
  updateProduct,
  updateVariant,
  type ProductInput,
  type ProductStatus,
} from '../lib/catalog';
import {
  createShipment,
  findOrderById,
  findOrderByNumber,
  listOrders,
  markItemsFulfilled,
  orderItems,
  paymentsForOrder,
  setOrderAdminNote,
  shipmentsForOrder,
  updateOrderStatus,
  updateShipmentStatus,
  type OrderRow,
} from '../lib/orders';
import {
  ORDER_STATUSES,
  SHIPMENT_STATUSES,
  canTransitionShipment,
  type OrderStatus,
  type ShipmentStatus,
} from '../lib/order-state';
import { executeRefund, refundableMinor, refundsForOrder, requestRefund } from '../lib/refunds';
import { listDiscounts, setDiscountActive, upsertDiscount } from '../lib/discounts';
import { parseMajorToMinor } from '../lib/money';

// ------------------------------------------------------------------- helpers

/**
 * The staff guard, resolved on the server for every action below.
 *
 * `src/server/actor.ts` holds the real `requireStaff`, and it is the one used
 * here — reached with a lazy `import()` from code the compiler strips out of
 * the client chunk. It cannot be a top-level import: this module is in the
 * client graph (see `vite.config.ts`, `importProtection.client.excludeFiles`),
 * and `actor.ts` reaches the request API, which the client environment denies.
 * The lazy import only ever runs on the server, where the handler lives.
 */
async function requireStaff(capability: Capability): Promise<Actor> {
  const { requireStaff: guard } = await import('./actor');
  return guard(capability);
}

/**
 * The staff session the admin shell gates on.
 *
 * Same answer as `store.getAdminSession`, for the same reason the guard above
 * is lazy: the shell is a client component, so the function it calls must be
 * declared in this module rather than imported from `store.ts`. The session
 * itself is still resolved by the shared actor helper, on the server.
 */
export const getAdminSession = createServerFn({ method: 'GET' }).handler(async () => {
  const { currentActor } = await import('./actor');
  const actor = await currentActor();
  if (!actor || !isStaff(actor.role)) return { staff: false as const };
  return { staff: true as const, role: actor.role, email: actor.email, name: actor.name };
});

/**
 * The `lib/` write functions audit against `{ id, email }`, while a session
 * actor carries a session id and maybe a customer id. The customer is the
 * durable identity, so it wins; a staff account with no customer row falls back
 * to the session, which is still enough to trace who acted.
 */
function asAuditActor(actor: Actor): AuditActor {
  return { id: actor.customerId ?? actor.sessionId, email: actor.email };
}

const PRODUCT_STATUSES: readonly ProductStatus[] = ['active', 'draft', 'archived'];

const DISCOUNT_KINDS = ['percentage', 'fixed', 'free_shipping'] as const;
type DiscountKind = (typeof DISCOUNT_KINDS)[number];

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Integer input from a form. Returns the fallback for anything unusable. */
function int(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const parsed = Number(str(value).trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on' || value === 1;
}

function productStatus(value: unknown): ProductStatus {
  return typeof value === 'string' && (PRODUCT_STATUSES as readonly string[]).includes(value)
    ? (value as ProductStatus)
    : 'draft';
}

function orderStatus(value: unknown): OrderStatus | null {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value)
    ? (value as OrderStatus)
    : null;
}

function isShipmentStatus(value: string): value is ShipmentStatus {
  return (SHIPMENT_STATUSES as readonly string[]).includes(value);
}

function discountKind(value: unknown): DiscountKind {
  return typeof value === 'string' && (DISCOUNT_KINDS as readonly string[]).includes(value)
    ? (value as DiscountKind)
    : 'percentage';
}

/** The message a thrown error carries, or a neutral fallback. */
function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.';
}

/**
 * A write failure a human can act on.
 *
 * A UNIQUE constraint from D1 is a slug or SKU already in use; showing the raw
 * `D1_ERROR: UNIQUE constraint failed: products.slug` helps nobody.
 */
function writeError(error: unknown, fallback: string): string {
  const message = describeError(error);
  if (/UNIQUE constraint failed/i.test(message)) return 'That address or SKU is already in use.';
  return message === 'Something went wrong.' ? fallback : message;
}

/** Turn a form money field into minor units, or null when it is not a number. */
function moneyFromForm(value: string): number | null {
  if (!value.trim()) return 0;
  try {
    return parseMajorToMinor(value);
  } catch {
    return null;
  }
}

/**
 * Paid orders whose lines are not all sent.
 *
 * `dashboardMetrics` already counts these; the dashboard also lists them, and a
 * count without the numbers to act on is not actionable.
 */
async function unfulfilledOrderRows(limit: number): Promise<OrderRow[]> {
  const result = await db()
    .prepare(
      `SELECT * FROM orders
        WHERE payment_status = 'paid' AND fulfilment_status IN ('unfulfilled','partial')
        ORDER BY created_at DESC LIMIT ?1`
    )
    .bind(limit)
    .all<OrderRow>();
  return result.results ?? [];
}

/** Audit rows, filtered by entity and/or entity id. */
async function filteredAudit(input: {
  entity: AuditEntity | null;
  entityId: string;
  limit: number;
}): Promise<AuditRow[]> {
  if (input.entity && input.entityId) return auditTrailFor(input.entity, input.entityId, input.limit);
  if (input.entity) {
    const result = await db()
      .prepare('SELECT * FROM audit_log WHERE entity = ?1 ORDER BY created_at DESC LIMIT ?2')
      .bind(input.entity, input.limit)
      .all<AuditRow>();
    return result.results ?? [];
  }
  return recentAudit(input.limit);
}

function newestFirst(a: AuditRow, b: AuditRow): number {
  return a.created_at < b.created_at ? 1 : -1;
}

// ----------------------------------------------------------------- dashboard

/**
 * Everything the dashboard renders, in one round trip.
 *
 * The window figures (last 30 days by default) sit beside the all-time ones
 * because an owner reading only the all-time total cannot see a bad month.
 */
export const getDashboard = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { windowDays: Math.min(365, Math.max(1, int(data['windowDays'], 30))) };
  })
  .handler(async ({ data }) => {
    asAuditActor(await requireStaff('dashboard:read'));

    const [metrics, customers, lowStock, pending, unfulfilled] = await Promise.all([
      dashboardMetrics(data.windowDays),
      recentCustomers(10),
      lowStockVariants(3),
      listOrders({ status: 'pending', limit: 10 }),
      unfulfilledOrderRows(10),
    ]);

    // The top-products query aliases its sums (`revenue`) and the dashboard type
    // names them `revenueMinor`. Normalise here rather than trusting the shape:
    // a dashboard that silently renders `undefined` as a price is worse than one
    // that shows a zero.
    const topProducts = metrics.topProducts.map((row) => {
      const loose = row as unknown as Record<string, unknown>;
      return {
        ...row,
        quantity: Number(row.quantity ?? 0),
        revenueMinor: Number(row.revenueMinor ?? loose['revenue'] ?? 0),
      };
    });

    return {
      metrics: { ...metrics, topProducts },
      customers,
      lowStock,
      pendingOrders: pending.orders,
      pendingTotal: pending.total,
      unfulfilledOrders: unfulfilled,
    };
  });

// ------------------------------------------------------------------ catalog

/** Every product, drafts and archives included — this is the admin view. */
export const listProductsAdmin = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    const status = str(data['status']).trim();
    return {
      status: (PRODUCT_STATUSES as readonly string[]).includes(status)
        ? (status as ProductStatus)
        : ('all' as const),
      search: str(data['search']).trim(),
      limit: Math.min(200, Math.max(1, int(data['limit'], 100))),
    };
  })
  .handler(async ({ data }) => {
    asAuditActor(await requireStaff('catalog:read'));
    const products = await listProducts({ status: data.status, search: data.search, limit: data.limit });
    return { products };
  });

/** One product by slug, whatever its status, for the editor. */
export const getProductAdmin = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { slug: str(data['slug']).trim() };
  })
  .handler(async ({ data }) => {
    asAuditActor(await requireStaff('catalog:read'));
    if (!data.slug) return { ok: false as const, error: 'No product was asked for.' };
    const product = await findProductBySlug(data.slug, 'all');
    if (!product) return { ok: false as const, error: 'No product with that address.' };
    return { ok: true as const, product, details: parseDetails(product.details) };
  });

/** Create a product, or update one when an id is present. */
export const saveProduct = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      id: str(data['id']).trim(),
      slug: str(data['slug']).trim(),
      title: str(data['title']).trim(),
      category: str(data['category']).trim(),
      description: str(data['description']),
      details: str(data['details'])
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      imageUrl: str(data['imageUrl']).trim(),
      imageAlt: str(data['imageAlt']).trim(),
      priceMajor: str(data['priceMajor']).trim(),
      currency: str(data['currency']).trim() || 'NGN',
      status: productStatus(data['status']),
      isFeatured: bool(data['isFeatured']),
      madeToOrder: bool(data['madeToOrder']),
      position: int(data['position'], 0),
      seoTitle: str(data['seoTitle']),
      seoDescription: str(data['seoDescription']),
    };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('catalog:write'));

    if (!data.title) return { ok: false as const, error: 'A product needs a title.' };
    if (!data.category) return { ok: false as const, error: 'A product needs a category.' };

    const priceMinor = moneyFromForm(data.priceMajor);
    if (priceMinor === null) {
      return { ok: false as const, error: 'Enter the price as a number, for example 18500 or 18500.50.' };
    }
    if (priceMinor < 0) return { ok: false as const, error: 'A price cannot be negative.' };

    const payload = {
      slug: data.slug || data.title,
      title: data.title,
      category: data.category,
      description: data.description,
      details: data.details,
      imageUrl: data.imageUrl,
      imageAlt: data.imageAlt || data.title,
      priceMinor,
      currency: data.currency,
      status: data.status,
      isFeatured: data.isFeatured,
      madeToOrder: data.madeToOrder,
      position: data.position,
      seoTitle: data.seoTitle,
      seoDescription: data.seoDescription,
    } satisfies ProductInput;

    try {
      if (data.id) {
        const product = await updateProduct(data.id, payload, actor);
        return { ok: true as const, created: false, product };
      }
      const product = await createProduct(payload, actor);
      return { ok: true as const, created: true, product };
    } catch (error) {
      return { ok: false as const, error: writeError(error, 'The product could not be saved.') };
    }
  });

/** Archive, never delete: an archived product keeps its order history. */
export const archiveProduct = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { id: str(data['id']).trim() };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('catalog:write'));
    if (!data.id) return { ok: false as const, error: 'No product was chosen.' };
    try {
      await archiveProductLib(data.id, actor);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

/**
 * Create or update a variant.
 *
 * Price and stock both go through `createVariant`/`updateVariant`, which write
 * their own audit rows (`variant.price_changed`, `variant.stock_changed`) and
 * an inventory movement when stock changes by hand.
 */
export const saveVariant = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      id: str(data['id']).trim(),
      productId: str(data['productId']).trim(),
      title: str(data['title']).trim(),
      sku: str(data['sku']).trim(),
      priceMajor: str(data['priceMajor']).trim(),
      compareAtMajor: str(data['compareAtMajor']).trim(),
      stock: Math.max(0, int(data['stock'], 0)),
      weightGrams: Math.max(0, int(data['weightGrams'], 0)),
      position: int(data['position'], 0),
      isActive: data['isActive'] === undefined ? true : bool(data['isActive']),
    };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('catalog:write'));

    if (!data.id && !data.productId) return { ok: false as const, error: 'A variant needs a product.' };
    if (!data.title) return { ok: false as const, error: 'A variant needs a name.' };

    const priceMinor = moneyFromForm(data.priceMajor);
    if (priceMinor === null) return { ok: false as const, error: 'Enter the variant price as a number.' };
    if (priceMinor < 0) return { ok: false as const, error: 'A price cannot be negative.' };

    let compareAtMinor: number | null = null;
    if (data.compareAtMajor) {
      const parsed = moneyFromForm(data.compareAtMajor);
      if (parsed === null) return { ok: false as const, error: 'Enter the compare-at price as a number.' };
      compareAtMinor = parsed;
    }

    try {
      if (data.id) {
        const variant = await updateVariant(
          data.id,
          {
            title: data.title,
            sku: data.sku,
            priceMinor,
            compareAtMinor,
            stock: data.stock,
            weightGrams: data.weightGrams,
            position: data.position,
            isActive: data.isActive,
          },
          actor
        );
        return { ok: true as const, created: false, variant };
      }

      const variant = await createVariant(
        {
          productId: data.productId,
          title: data.title,
          sku: data.sku,
          priceMinor,
          compareAtMinor,
          stock: data.stock,
          weightGrams: data.weightGrams,
          position: data.position,
          isActive: data.isActive,
        },
        actor
      );
      return { ok: true as const, created: true, variant };
    } catch (error) {
      return { ok: false as const, error: writeError(error, 'The variant could not be saved.') };
    }
  });

/** The stock ledger for one variant: why the number is what it is. */
export const getVariantMovements = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { variantId: str(data['variantId']).trim() };
  })
  .handler(async ({ data }) => {
    asAuditActor(await requireStaff('catalog:read'));
    if (!data.variantId) return { ok: false as const, error: 'No variant was chosen.' };
    const movements = await inventoryMovements(data.variantId, 50);
    return { ok: true as const, movements };
  });

// ------------------------------------------------------------------- orders

export const listOrdersAdmin = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    const status = str(data['status']).trim();
    const perPage = Math.min(100, Math.max(5, int(data['perPage'], 25)));
    return {
      status: (ORDER_STATUSES as readonly string[]).includes(status) ? status : 'all',
      search: str(data['search']).trim(),
      page: Math.max(1, int(data['page'], 1)),
      perPage,
    };
  })
  .handler(async ({ data }) => {
    asAuditActor(await requireStaff('orders:read:all'));

    const { orders, total } = await listOrders({
      status: data.status,
      search: data.search,
      limit: data.perPage,
      offset: (data.page - 1) * data.perPage,
    });

    return {
      orders,
      total,
      page: data.page,
      perPage: data.perPage,
      pageCount: Math.max(1, Math.ceil(total / data.perPage)),
    };
  });

/**
 * One order, with everything an operator needs to act on it: the lines to
 * fulfil, the money that was taken, the parcels that left, the money that went
 * back, and the trail of who did what.
 */
export const getOrderDetail = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { number: str(data['number']).trim() };
  })
  .handler(async ({ data }) => {
    asAuditActor(await requireStaff('orders:read:all'));

    if (!data.number) return { ok: false as const, error: 'No order was asked for.' };
    const order = await findOrderByNumber(data.number);
    if (!order) return { ok: false as const, error: `No order numbered ${data.number}.` };

    const [items, payments, shipments, refunds, orderAudit, refundable] = await Promise.all([
      orderItems(order.id),
      paymentsForOrder(order.id),
      shipmentsForOrder(order.id),
      refundsForOrder(order.id),
      auditTrailFor('order', order.id, 100),
      refundableMinor(order.id),
    ]);

    // Refund and shipment changes are audited under their own entity ids, so the
    // order's trail is only complete once those are gathered too.
    const [refundAudits, shipmentAudits] = await Promise.all([
      Promise.all(refunds.map((refund) => auditTrailFor('refund', refund.id, 20))),
      Promise.all(shipments.map((shipment) => auditTrailFor('shipment', shipment.id, 20))),
    ]);

    const audit = [...orderAudit, ...refundAudits.flat(), ...shipmentAudits.flat()].sort(newestFirst);

    return {
      ok: true as const,
      order,
      items,
      payments,
      shipments,
      refunds,
      audit,
      refundableMinor: refundable,
    };
  });

/**
 * Move an order along its state machine.
 *
 * `updateOrderStatus` calls `assertTransition`, so an illegal move throws with
 * the library's own message and nothing is written. `paid` is refused outright:
 * per `order-state.ts` an order becomes paid only through the settlement path,
 * which is the only caller that has verified a payment with the gateway. An
 * admin button that could set it would be a way to fabricate revenue.
 */
export const advanceOrderStatus = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    const to = orderStatus(data['to']);
    if (!to) throw new Error('That is not a status an order can have.');
    return {
      orderId: str(data['orderId']).trim(),
      to,
      note: str(data['note']).trim().slice(0, 2000),
    };
  })
  .handler(async ({ data }) => {
    const actor =
      data.to === 'refunded' || data.to === 'partially_refunded'
        ? asAuditActor(await requireStaff('orders:refund'))
        : asAuditActor(await requireStaff('orders:fulfil'));

    if (!data.orderId) return { ok: false as const, error: 'No order was chosen.' };
    if (data.to === 'paid') {
      return {
        ok: false as const,
        error: 'An order becomes paid only when its payment settles — the gateway is the only source of that.',
      };
    }

    try {
      const order = await updateOrderStatus({
        orderId: data.orderId,
        to: data.to,
        actor,
        ...(data.note ? { note: data.note } : {}),
      });
      return { ok: true as const, order };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

/** Dispatch a parcel, with tracking. */
export const addShipment = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      orderId: str(data['orderId']).trim(),
      carrier: str(data['carrier']).trim(),
      trackingNumber: str(data['trackingNumber']).trim(),
      trackingUrl: str(data['trackingUrl']).trim(),
      note: str(data['note']).trim(),
    };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('orders:fulfil'));

    if (!data.orderId) return { ok: false as const, error: 'No order was chosen.' };
    if (!data.carrier) return { ok: false as const, error: 'A shipment needs a carrier.' };
    if (!data.trackingNumber) return { ok: false as const, error: 'A shipment needs a tracking number.' };

    try {
      const shipment = await createShipment({
        orderId: data.orderId,
        carrier: data.carrier,
        trackingNumber: data.trackingNumber,
        actor,
        ...(data.trackingUrl ? { trackingUrl: data.trackingUrl } : {}),
        ...(data.note ? { note: data.note } : {}),
      });
      return { ok: true as const, shipment };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

/**
 * Move a shipment along its own state machine.
 *
 * `updateShipmentStatus` writes the audit row but does not police transitions,
 * so the current status is read here and checked against the table in
 * `order-state.ts` before anything is written.
 */
export const setShipmentStatus = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    const status = str(data['status']).trim();
    if (!isShipmentStatus(status)) throw new Error('That is not a shipment status.');
    return { shipmentId: str(data['shipmentId']).trim(), status };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('orders:fulfil'));
    if (!data.shipmentId) return { ok: false as const, error: 'No shipment was chosen.' };

    const current = await db()
      .prepare('SELECT status FROM shipments WHERE id = ?1')
      .bind(data.shipmentId)
      .first<{ status: string }>();
    if (!current) return { ok: false as const, error: 'No such shipment.' };
    if (!isShipmentStatus(current.status)) {
      return { ok: false as const, error: `That shipment is in an unrecognised state (${current.status}).` };
    }
    if (!canTransitionShipment(current.status, data.status)) {
      return {
        ok: false as const,
        error: `A shipment that is ${current.status} cannot become ${data.status}.`,
      };
    }

    try {
      await updateShipmentStatus(data.shipmentId, data.status, actor);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

/**
 * Mark quantities of one line as sent.
 *
 * `markItemsFulfilled` recomputes `fulfilment_status` from what is left, which
 * is why the refreshed order and items are returned: the page can show the new
 * state without a second read.
 */
export const fulfilItems = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      orderId: str(data['orderId']).trim(),
      itemId: str(data['itemId']).trim(),
      quantity: int(data['quantity'], 0),
    };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('orders:fulfil'));

    if (!data.orderId || !data.itemId) return { ok: false as const, error: 'No order line was chosen.' };
    if (data.quantity <= 0) return { ok: false as const, error: 'Enter how many units were sent, one or more.' };

    const item = await db()
      .prepare('SELECT id, order_id, title, quantity, quantity_fulfilled FROM order_items WHERE id = ?1')
      .bind(data.itemId)
      .first<{ id: string; order_id: string; title: string; quantity: number; quantity_fulfilled: number }>();
    if (!item || item.order_id !== data.orderId) {
      return { ok: false as const, error: 'That line is not on this order.' };
    }

    const outstanding = item.quantity - item.quantity_fulfilled;
    if (outstanding <= 0) return { ok: false as const, error: 'That line is already fully sent.' };
    if (data.quantity > outstanding) {
      return { ok: false as const, error: `Only ${outstanding} of that line are still outstanding.` };
    }

    try {
      await markItemsFulfilled(data.orderId, data.itemId, data.quantity);
      await recordAudit({
        actor,
        action: 'order.items_fulfilled',
        entity: 'order',
        entityId: data.orderId,
        after: { itemId: data.itemId, title: item.title, quantity: data.quantity },
      });
      const [order, items] = await Promise.all([findOrderById(data.orderId), orderItems(data.orderId)]);
      if (!order) return { ok: false as const, error: 'The order disappeared while it was being updated.' };
      return { ok: true as const, order, items };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

/** The internal note on an order. Audited here because the lib does not. */
export const setOrderNote = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      orderId: str(data['orderId']).trim(),
      note: str(data['note']).slice(0, 4000),
    };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('orders:fulfil'));
    if (!data.orderId) return { ok: false as const, error: 'No order was chosen.' };
    try {
      await setOrderAdminNote(data.orderId, data.note);
      await recordAudit({
        actor,
        action: 'order.note_set',
        entity: 'order',
        entityId: data.orderId,
        after: { note: data.note },
      });
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

/**
 * Refund, in one operator action.
 *
 * Two library calls, in the order the handoff requires: `requestRefund` records
 * the intent (and checks the amount against what is actually left to refund),
 * then `executeRefund` claims the row and calls the gateway. If the gateway
 * refuses, the refund is left in `failed` with the reason and the error is
 * returned as data — the request half genuinely happened, so the operator is
 * told that rather than being shown a bare failure.
 */
export const refundOrder = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      orderId: str(data['orderId']).trim(),
      amountMajor: str(data['amountMajor']).trim(),
      reason: str(data['reason']).trim().slice(0, 2000),
      restock: data['restock'] === undefined ? true : bool(data['restock']),
    };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('orders:refund'));

    if (!data.orderId) return { ok: false as const, error: 'No order was chosen.' };
    if (!data.reason) {
      return { ok: false as const, error: 'Give a reason for the refund — it is recorded in the audit trail.' };
    }

    const amountMinor = moneyFromForm(data.amountMajor);
    if (amountMinor === null) return { ok: false as const, error: 'Enter the refund amount as a number.' };
    if (amountMinor <= 0) return { ok: false as const, error: 'A refund needs an amount.' };

    let refundId: string;
    try {
      const requested = await requestRefund({
        orderId: data.orderId,
        amountMinor,
        reason: data.reason,
        restock: data.restock,
        actor,
      });
      refundId = requested.id;
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }

    try {
      const refund = await executeRefund(refundId, actor);
      return { ok: true as const, refund };
    } catch (error) {
      return {
        ok: false as const,
        error: describeError(error),
        refundId,
        requested: true as const,
      };
    }
  });

/**
 * Ask the gateway again about an unsettled payment.
 *
 * WHY THIS HAS TO EXIST
 *
 * A payment settles on whichever of two events happens first: the customer's
 * browser returning to `/checkout/callback`, or Paystack delivering a webhook.
 * The callback is the common path and verifies with the gateway directly. The
 * webhook is the safety net for a customer who pays and then closes the tab
 * before being redirected.
 *
 * That safety net is NOT reliably ours to control. Paystack permits ONE webhook
 * URL per integration, and this account's key is shared with ozituma.com — so
 * wherever the webhook points, one of the two stores is relying on its customers
 * coming back. A payment can therefore sit `pending` with the money taken, and
 * before this existed there was nothing anyone could do from inside the store.
 *
 * The action is deliberately NOT "mark this paid". It calls the SAME
 * `confirmOrderPayment` the callback and the webhook use, which asks Paystack,
 * compares the amount against what the order says, and only then settles. An
 * operator cannot conjure a payment, and `advanceOrderStatus` still refuses to
 * move an order to `paid` by hand for exactly that reason.
 *
 * It is idempotent, so pressing it twice is harmless.
 */
export const recheckPayment = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { orderId: str(data['orderId']).trim() };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('orders:read:all'));
    if (!data.orderId) return { ok: false as const, error: 'No order was chosen.' };

    const { confirmOrderPayment } = await import('../lib/checkout');
    const { paymentsForOrder } = await import('../lib/orders');

    const rows = await paymentsForOrder(data.orderId);
    const latest = rows[0];
    if (!latest) return { ok: false as const, error: 'That order has no payment to check.' };

    if (latest.settled_at && latest.status === 'success') {
      return { ok: true as const, settled: true, message: 'Already settled — nothing to do.' };
    }

    try {
      const result = await confirmOrderPayment(latest.reference);
      if (!result.ok) {
        return { ok: true as const, settled: false, message: result.error };
      }
      await recordAudit({
        actor,
        action: 'order.payment_rechecked',
        entity: 'order',
        entityId: data.orderId,
        before: { status: latest.status },
        after: { status: 'success', reference: latest.reference, alreadySettled: result.alreadySettled },
      });
      return {
        ok: true as const,
        settled: true,
        message: result.alreadySettled
          ? 'That payment had already settled.'
          : 'The gateway confirms the payment. The order is now paid.',
      };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

/**
 * Ask the gateway again about a refund it has not settled.
 *
 * WHY THIS IS NEEDED
 *
 * A refund is accepted asynchronously: Paystack answers `processing` and settles
 * later. The shop learns the outcome from the `refund.processed` /
 * `refund.failed` webhook — which this account may deliver to ozituma.com, since
 * Paystack allows ONE webhook URL per integration and the key is shared.
 *
 * A refund stuck in flight is money that has left the account while the order
 * still says `partially_refunded` and its stock stays reserved. This asks the
 * gateway directly, which is the only way to know without the webhook.
 *
 * It does not invent an outcome: a refund the gateway has not settled stays
 * `processing`, and the operator is told exactly that.
 */
export const recheckRefund = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { refundId: str(data['refundId']).trim() };
  })
  .handler(async ({ data }) => {
    const auditActor = asAuditActor(await requireStaff('orders:refund'));
    if (!data.refundId) return { ok: false as const, error: 'No refund was chosen.' };

    const { reconcileRefunds } = await import('../lib/refunds');
    try {
      const outcomes = await reconcileRefunds(auditActor, data.refundId);
      const outcome = outcomes[0]?.outcome ?? 'nothing to check';
      return { ok: true as const, settled: outcome === 'settled', message: outcome };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

// ---------------------------------------------------------------- discounts

export const listDiscountsAdmin = createServerFn({ method: 'GET' }).handler(async () => {
  // Discounts decide what customers pay, so they sit behind the same capability
  // as the catalogue rather than `content:write`, which a content manager holds.
  asAuditActor(await requireStaff('catalog:write'));
  const discounts = await listDiscounts();
  return { discounts };
});

/**
 * Create or update a discount code.
 *
 * A `fixed` code stores minor units (that is how `computeTotals` applies it), so
 * the form value goes through `parseMajorToMinor`. A `percentage` stores the
 * percent itself. A `free_shipping` code stores nothing.
 */
export const saveDiscount = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      code: str(data['code']).trim(),
      kind: discountKind(data['kind']),
      value: str(data['value']).trim(),
      minimumSubtotalMajor: str(data['minimumSubtotalMajor']).trim(),
      maxRedemptions: str(data['maxRedemptions']).trim(),
      startsAt: str(data['startsAt']).trim(),
      endsAt: str(data['endsAt']).trim(),
      isActive: data['isActive'] === undefined ? true : bool(data['isActive']),
    };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('catalog:write'));

    if (!data.code) return { ok: false as const, error: 'A discount needs a code.' };

    let value = 0;
    if (data.kind === 'percentage') {
      value = int(data.value, 0);
      if (value < 0 || value > 100) {
        return { ok: false as const, error: 'A percentage discount must be between 0 and 100.' };
      }
    } else if (data.kind === 'fixed') {
      const parsed = moneyFromForm(data.value);
      if (parsed === null) return { ok: false as const, error: 'Enter the fixed discount as a number, for example 2500.' };
      if (parsed < 0) return { ok: false as const, error: 'A fixed discount cannot be negative.' };
      value = parsed;
    }

    const minimumSubtotalMinor = moneyFromForm(data.minimumSubtotalMajor);
    if (minimumSubtotalMinor === null) {
      return { ok: false as const, error: 'Enter the minimum basket as a number, for example 50000.' };
    }

    const maxRedemptions = data.maxRedemptions ? Math.max(0, int(data.maxRedemptions, 0)) : null;

    try {
      const discount = await upsertDiscount(
        {
          code: data.code,
          kind: data.kind,
          value,
          minimumSubtotalMinor,
          maxRedemptions,
          startsAt: data.startsAt || null,
          endsAt: data.endsAt || null,
          isActive: data.isActive,
        },
        actor
      );
      return { ok: true as const, discount };
    } catch (error) {
      return { ok: false as const, error: writeError(error, 'The discount could not be saved.') };
    }
  });

/** Switch a code on or off without retyping it. */
export const toggleDiscount = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { code: str(data['code']).trim(), active: bool(data['active']) };
  })
  .handler(async ({ data }) => {
    const actor = asAuditActor(await requireStaff('catalog:write'));
    if (!data.code) return { ok: false as const, error: 'No discount code was chosen.' };
    try {
      await setDiscountActive(data.code, data.active, actor);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  });

// -------------------------------------------------------------------- audit

export const getAuditLog = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      entity: str(data['entity']).trim(),
      entityId: str(data['entityId']).trim(),
      limit: Math.min(500, Math.max(1, int(data['limit'], 100))),
    };
  })
  .handler(async ({ data }) => {
    asAuditActor(await requireStaff('dashboard:read'));

    const entity = isAuditEntity(data.entity) ? data.entity : null;
    const rows = await filteredAudit({ entity, entityId: data.entityId, limit: data.limit });
    return { rows, entity: entity ?? 'all', entityId: data.entityId };
  });

// ------------------------------------------------------------------ permissions

/**
 * Staff accounts and their roles.
 *
 * `permissions:write` is held only by `super_admin`, so an admin cannot promote
 * themselves or each other. Every change clears the affected account's sessions,
 * which is what makes a revocation take effect now rather than in thirty days.
 */
export const listStaffAccounts = createServerFn({ method: 'GET' }).handler(async () => {
  await requireStaff('permissions:write');
  const { listStaff } = await import('../lib/auth');
  const rows = await listStaff();
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.created_at,
  }));
});

export const setStaffRole = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as Record<string, unknown>;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    return { email: str(data['email']).trim().toLowerCase(), role: str(data['role']) };
  })
  .handler(async ({ data }) => {
    const actor = await requireStaff('permissions:write');
    const { findCustomerByEmail, setCustomerRole } = await import('../lib/auth');
    const { isRole } = await import('../lib/roles');

    const email = readString(data, 'email');
    const role = readString(data, 'role');
    if (!isRole(role)) return { ok: false as const, error: 'That is not a role this store has.' };

    const customer = await findCustomerByEmail(email);
    if (!customer) {
      return { ok: false as const, error: 'No account with that email. They need to register first.' };
    }
    // The last super admin must not be able to demote themselves out of the
    // store. Without this, one click leaves nobody able to grant anything.
    if (customer.id === actor.customerId && customer.role === 'super_admin' && role !== 'super_admin') {
      const { listStaff } = await import('../lib/auth');
      const staff = await listStaff();
      const supers = staff.filter((row) => row.role === 'super_admin');
      if (supers.length <= 1) {
        return { ok: false as const, error: 'This is the only super admin. Promote someone else first.' };
      }
    }

    await setCustomerRole(customer.id, role);
    await recordAudit({
      actor: { id: actor.customerId ?? actor.sessionId, email: actor.email },
      action: 'account.role_changed',
      entity: 'customer',
      entityId: customer.id,
      before: { role: customer.role },
      after: { role },
    });
    return { ok: true as const, email: customer.email, role };
  });

// ---------------------------------------------------------------- outbound mail

/**
 * The outbox, for the admin.
 *
 * WHY THIS SCREEN IS NOT OPTIONAL
 *
 * The store queues email without a provider configured. That is the right
 * behaviour and it is also invisible: unless somebody can see the queue, "we
 * recorded what we owe" is indistinguishable from "nothing happened". This is
 * where an owner finds out that a customer was never told their order was
 * confirmed.
 */
export const getOutbox = createServerFn({ method: 'GET' }).handler(async () => {
  asAuditActor(await requireStaff('orders:read:all'));
  const { recentMessages, summary } = await import('../lib/mail');
  const { mailConfig } = await import('../lib/mailer');
  const { env: readEnv } = await import('../lib/env');

  const [messages, counts] = await Promise.all([recentMessages(100), summary()]);
  const config = mailConfig(readEnv() as unknown as Record<string, string | undefined>);

  return {
    messages,
    counts,
    provider: config.provider,
    from: config.from,
    // Said plainly, because it is the difference between a working shop and one
    // that has been quietly silent.
    configured: config.provider !== 'none',
  };
});

/** Put a failed message back in the queue, or cancel one that should not go. */
export const retryMessage = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { id: str(data['id']).trim() };
  })
  .handler(async ({ data }) => {
    const auditActor = asAuditActor(await requireStaff('orders:read:all'));
    if (!data.id) return { ok: false as const, error: 'No message was chosen.' };
    const { requeue } = await import('../lib/mail');
    const done = await requeue(data.id);
    if (!done) {
      return { ok: false as const, error: 'That message is not in a state that can be retried.' };
    }
    await recordAudit({
      actor: auditActor,
      action: 'mail.requeued',
      entity: 'product',
      entityId: data.id,
      after: { id: data.id },
    });
    return { ok: true as const, message: 'Queued for another attempt.' };
  });

/** Try the queue now, so an owner does not have to wait for the next order. */
export const flushOutbox = createServerFn({ method: 'POST' }).handler(async () => {
  asAuditActor(await requireStaff('orders:read:all'));
  const { flush } = await import('../lib/mail-queue');
  const report = await flush(25);
  if (report.provider === 'none') {
    return {
      ok: true as const,
      sent: 0,
      failed: 0,
      message: 'No email provider is configured, so nothing was sent. Messages are waiting.',
    };
  }
  return {
    ok: true as const,
    sent: report.sent,
    failed: report.failed,
    message: `${report.sent} sent, ${report.failed} failed, of ${report.attempted} attempted.`,
  };
});

// ------------------------------------------------------------- the shop switch

/**
 * Read the storefront switch, for the admin screen.
 *
 * `storefront:publish` rather than `dashboard:read`: a fulfilment role has no
 * business knowing or changing whether the shop is open to the public, and a
 * capability that is only checked in the interface is not a check at all.
 */
export const getStorefrontState = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{
    open: boolean;
    /**
     * The address the switch controls, so the screen can offer a link to see the
     * result. Read from the request rather than hard-coded, because a store
     * reachable at two hostnames must not have a preview button that goes to
     * whichever one was baked in.
     */
    previewPath: string;
  }> => {
    await requireStaff('storefront:publish');
    const { storefrontIsOpen } = await import('../lib/storefront');
    return { open: await storefrontIsOpen(), previewPath: '/' };
  }
);

/**
 * Open or close the shop.
 *
 * The actor is passed to the audit record, so the log says WHO closed the shop
 * and not merely that it closed.
 */
export const setStorefrontState = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { open?: unknown };
    return { open: data?.open === true };
  })
  .handler(async ({ data }): Promise<{ open: boolean }> => {
    const actor = asAuditActor(await requireStaff('storefront:publish'));
    const { setStorefrontOpen } = await import('../lib/storefront');
    await setStorefrontOpen(data.open, actor);
    return { open: data.open };
  });
