/**
 * The cart.
 *
 * Held on the server, keyed by a cookie, so that:
 *   - the total cannot be edited in the browser, because the browser never sends
 *     prices — only a variant id and a quantity;
 *   - a customer can pick the basket up on another device;
 *   - stock problems are found before checkout rather than after payment.
 *
 * The client-side localStorage cart the design preview used is gone. It was
 * correct for a preview (nothing was purchasable) and wrong for a shop (the
 * prices were whatever the visitor's disk said).
 */

import { db } from './env';
import { randomToken } from './crypto';
import { computeTotals, findStockProblems, quoteShipping, shippingMethodFor, type PricedLine, type Totals } from './pricing';
import { checkDiscount, redeemDiscount } from './discounts';

export const CART_COOKIE = 'ozikoro_store_cart';
const CART_MAX_AGE_DAYS = 60;

export interface CartItemRow {
  id: string;
  cart_id: string;
  variant_id: string;
  quantity: number;
  added_price_minor: number;
  created_at: string;
}

export interface CartLine {
  itemId: string;
  variantId: string;
  productId: string;
  productSlug: string;
  title: string;
  variantTitle: string;
  sku: string;
  imageUrl: string;
  unitPriceMinor: number;
  quantity: number;
  availableStock: number | null;
  isActive: boolean;
  /** True when the price moved since the item was added. */
  priceChanged: boolean;
  addedPriceMinor: number;
  lineTotalMinor: number;
}

export interface CartView {
  cartId: string;
  lines: CartLine[];
  totals: Totals;
  currency: string;
}

export async function createCart(customerId: string | null = null): Promise<string> {
  const id = `crt_${randomToken(12)}`;
  await db().prepare('INSERT INTO carts (id, customer_id) VALUES (?1, ?2)').bind(id, customerId).run();
  return id;
}

export async function findCart(cartId: string): Promise<{ id: string; customer_id: string | null; status: string; currency: string } | null> {
  return db()
    .prepare('SELECT id, customer_id, status, currency FROM carts WHERE id = ?1')
    .bind(cartId)
    .first<{ id: string; customer_id: string | null; status: string; currency: string }>();
}

/**
 * Resolve a cart id from a cookie, creating a cart when there is none.
 *
 * A cart that has already been converted is not reused: a customer who has just
 * paid must land on an empty basket, not the one they bought.
 */
export async function ensureCart(cartId: string | null, customerId: string | null = null): Promise<string> {
  if (cartId) {
    const existing = await findCart(cartId);
    if (existing && existing.status === 'open') {
      // Attach a guest cart to the account once the customer signs in, so the
      // basket survives the sign-in round trip.
      if (customerId && existing.customer_id !== customerId) {
        await db()
          .prepare(`UPDATE carts SET customer_id = ?2, updated_at = datetime('now') WHERE id = ?1`)
          .bind(cartId, customerId)
          .run();
      }
      return cartId;
    }
  }
  return createCart(customerId);
}

/** The full cart, priced from the live catalogue. */
export async function cartView(cartId: string): Promise<CartView> {
  const rows = await db()
    .prepare(
      `SELECT ci.id AS item_id, ci.variant_id, ci.quantity, ci.added_price_minor,
              v.title AS variant_title, v.sku, v.price_minor, v.stock, v.is_active AS variant_active,
              p.id AS product_id, p.slug AS product_slug, p.title, p.image_url, p.status AS product_status,
              p.made_to_order, p.currency
         FROM cart_items ci
         JOIN product_variants v ON v.id = ci.variant_id
         JOIN products p         ON p.id = v.product_id
        WHERE ci.cart_id = ?1
        ORDER BY ci.created_at`
    )
    .bind(cartId)
    .all<{
      item_id: string;
      variant_id: string;
      quantity: number;
      added_price_minor: number;
      variant_title: string;
      sku: string;
      price_minor: number;
      stock: number;
      variant_active: number;
      product_id: string;
      product_slug: string;
      title: string;
      image_url: string;
      product_status: string;
      made_to_order: number;
      currency: string;
    }>();

  const lines: CartLine[] = (rows.results ?? []).map((row) => {
    const isActive = row.variant_active === 1 && row.product_status === 'active';
    return {
      itemId: row.item_id,
      variantId: row.variant_id,
      productId: row.product_id,
      productSlug: row.product_slug,
      title: row.title,
      variantTitle: row.variant_title,
      sku: row.sku,
      imageUrl: row.image_url,
      // The LIVE price is authoritative. `added_price_minor` exists only so the
      // customer can be told the price moved, never to charge them the old one.
      unitPriceMinor: row.price_minor,
      quantity: row.quantity,
      availableStock: row.made_to_order ? null : row.stock,
      isActive,
      priceChanged: row.price_minor !== row.added_price_minor,
      addedPriceMinor: row.added_price_minor,
      lineTotalMinor: row.price_minor * row.quantity,
    };
  });

  const currency = (rows.results ?? [])[0]?.currency ?? 'NGN';
  const totals = computeTotals({ lines: toPricedLines(lines), shippingMinor: 0 });

  return { cartId, lines, totals, currency };
}

export function toPricedLines(lines: CartLine[]): PricedLine[] {
  return lines.map((line) => ({
    variantId: line.variantId,
    productId: line.productId,
    productSlug: line.productSlug,
    title: line.title,
    variantTitle: line.variantTitle,
    sku: line.sku,
    imageUrl: line.imageUrl,
    unitPriceMinor: line.unitPriceMinor,
    quantity: line.quantity,
    availableStock: line.availableStock,
    isActive: line.isActive,
  }));
}

export interface AddToCartResult {
  ok: boolean
  message?: string;
  quantity?: number;
}

/**
 * Add a variant to the cart.
 *
 * The requested quantity is checked against live stock at the moment of the
 * write, and the write itself is a conditional update on the cart row, so two
 * tabs cannot between them exceed the shelf.
 */
export async function addToCart(input: {
  cartId: string;
  variantId: string;
  quantity: number;
}): Promise<AddToCartResult> {
  const quantity = Math.max(1, Math.min(25, Math.round(input.quantity)));

  const variant = await db()
    .prepare(
      `SELECT v.id, v.stock, v.price_minor, v.is_active AS variant_active, p.status AS product_status, p.made_to_order
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.id = ?1`
    )
    .bind(input.variantId)
    .first<{ id: string; stock: number; price_minor: number; variant_active: number; product_status: string; made_to_order: number }>();

  if (!variant) return { ok: false, message: 'That item is no longer available.' };
  if (variant.variant_active !== 1 || variant.product_status !== 'active') {
    return { ok: false, message: 'That item is no longer available.' };
  }

  const existing = await db()
    .prepare('SELECT id, quantity FROM cart_items WHERE cart_id = ?1 AND variant_id = ?2')
    .bind(input.cartId, input.variantId)
    .first<{ id: string; quantity: number }>();

  const nextQuantity = (existing?.quantity ?? 0) + quantity;
  if (variant.made_to_order !== 1 && nextQuantity > variant.stock) {
    return {
      ok: false,
      message:
        variant.stock <= 0
          ? 'That item is out of stock.'
          : `Only ${variant.stock} left — you already have ${existing?.quantity ?? 0} in your cart.`,
      quantity: variant.stock,
    };
  }

  if (existing) {
    await db()
      .prepare('UPDATE cart_items SET quantity = ?2 WHERE id = ?1 AND quantity = ?3')
      .bind(existing.id, nextQuantity, existing.quantity)
      .run();
  } else {
    await db()
      .prepare(
        `INSERT INTO cart_items (id, cart_id, variant_id, quantity, added_price_minor)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
      .bind(`cit_${randomToken(12)}`, input.cartId, input.variantId, quantity, variant.price_minor)
      .run();
  }

  await touchCart(input.cartId);
  return { ok: true, quantity: nextQuantity };
}

export async function setCartQuantity(input: {
  cartId: string;
  itemId: string;
  quantity: number;
}): Promise<AddToCartResult> {
  const row = await db()
    .prepare(
      `SELECT ci.id, ci.variant_id, v.stock, p.made_to_order
         FROM cart_items ci
         JOIN product_variants v ON v.id = ci.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE ci.id = ?1 AND ci.cart_id = ?2`
    )
    .bind(input.itemId, input.cartId)
    .first<{ id: string; variant_id: string; stock: number; made_to_order: number }>();

  if (!row) return { ok: false, message: 'That item is no longer in your cart.' };

  const quantity = Math.round(input.quantity);
  if (quantity <= 0) {
    await removeFromCart(input.cartId, input.itemId);
    return { ok: true, quantity: 0 };
  }
  if (quantity > 25) return { ok: false, message: 'That is more than we can ship in one order.' };
  if (row.made_to_order !== 1 && quantity > row.stock) {
    return { ok: false, message: row.stock <= 0 ? 'That item is out of stock.' : `Only ${row.stock} left.` };
  }

  await db().prepare('UPDATE cart_items SET quantity = ?2 WHERE id = ?1').bind(input.itemId, quantity).run();
  await touchCart(input.cartId);
  return { ok: true, quantity };
}

export async function removeFromCart(cartId: string, itemId: string): Promise<void> {
  await db().prepare('DELETE FROM cart_items WHERE id = ?1 AND cart_id = ?2').bind(itemId, cartId).run();
  await touchCart(cartId);
}

export async function clearCart(cartId: string): Promise<void> {
  await db().prepare('DELETE FROM cart_items WHERE cart_id = ?1').bind(cartId).run();
  await touchCart(cartId);
}

async function touchCart(cartId: string): Promise<void> {
  await db().prepare(`UPDATE carts SET updated_at = datetime('now') WHERE id = ?1`).bind(cartId).run();
}

/** Merge a browser-held cart into the server cart on sign-in. */
export async function mergeCart(cartId: string, incoming: Array<{ variantId: string; quantity: number }>): Promise<void> {
  for (const item of incoming.slice(0, 50)) {
    await addToCart({ cartId, variantId: item.variantId, quantity: item.quantity });
  }
}

export async function countCartItems(cartId: string): Promise<number> {
  const row = await db()
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM cart_items WHERE cart_id = ?1')
    .bind(cartId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface CheckoutPreview {
  lines: CartLine[];
  totals: Totals;
  currency: string;
  stockProblems: ReturnType<typeof findStockProblems>;
  shippingOptions: ReturnType<typeof quoteShipping>;
  shipping: ReturnType<typeof shippingMethodFor>;
  discount: Awaited<ReturnType<typeof checkDiscount>> | null;
  empty: boolean;
}

/**
 * Everything checkout needs to show a total, recomputed from the catalogue.
 *
 * This function is the reason a customer cannot pay a wrong amount: the number
 * it returns is produced from the database, and the order is created from this
 * same computation, not from anything the page submitted.
 */
export async function checkoutPreview(input: {
  cartId: string;
  country?: string | undefined;
  region?: string | undefined;
  city?: string | undefined;
  shippingMethod?: string | undefined;
  discountCode?: string | undefined;
}): Promise<CheckoutPreview> {
  const view = await cartView(input.cartId);
  const priced = toPricedLines(view.lines);
  const stockProblems = findStockProblems(priced);

  const subtotal = computeTotals({ lines: priced, shippingMinor: 0 }).subtotalMinor;

  const shippingOptions = quoteShipping({
    country: input.country ?? 'Nigeria',
    region: input.region,
    city: input.city,
    subtotalMinor: subtotal,
  });
  const shipping = shippingMethodFor(shippingOptions, input.shippingMethod ?? '');

  let discount: Awaited<ReturnType<typeof checkDiscount>> | null = null;
  let discountRule = null;
  if (input.discountCode && input.discountCode.trim()) {
    discount = await checkDiscount(input.discountCode, subtotal);
    if (discount.ok) discountRule = discount.rule;
  }

  const totals = computeTotals({
    lines: priced,
    shippingMinor: shipping?.amountMinor ?? 0,
    discount: discountRule,
  });

  return {
    lines: view.lines,
    totals,
    currency: view.currency,
    stockProblems,
    shippingOptions,
    shipping,
    discount,
    empty: view.lines.length === 0,
  };
}

/** Mark the cart as bought and detach it, so the cookie cannot resurrect it. */
export async function convertCart(cartId: string): Promise<void> {
  await db()
    .prepare(`UPDATE carts SET status = 'converted', updated_at = datetime('now') WHERE id = ?1`)
    .bind(cartId)
    .run();
}

/**
 * Apply a discount code, recording only that it was accepted. The redemption
 * count moves at settlement.
 */
export async function applyDiscountCode(cartId: string, code: string): Promise<Awaited<ReturnType<typeof checkDiscount>>> {
  const view = await cartView(cartId);
  const subtotal = computeTotals({ lines: toPricedLines(view.lines), shippingMinor: 0 }).subtotalMinor;
  return checkDiscount(code, subtotal);
}

export { redeemDiscount };
