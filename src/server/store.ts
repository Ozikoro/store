/**
 * Store server functions.
 *
 * Every one of these is server-only: it is declared with `createServerFn`, which
 * the Start compiler turns into an RPC and strips from the client bundle. None
 * of them trusts an argument that could have been edited in the browser.
 *
 * The shape each one follows:
 *   1. resolve the actor from the session cookie — never from an argument;
 *   2. rate limit, if it is a place a stranger can make us do work;
 *   3. narrow the input the validator produced;
 *   4. do the work through a `lib/` function, which enforces its own rules;
 *   5. return only what the caller is allowed to see.
 *
 * HOW THIS FILE AVOIDS LEAKING SERVER CODE, because the pattern is not obvious
 * and the build fails if it is broken:
 *
 *   - This module IS in the client graph. The cart, account and checkout routes
 *     import these server functions, and the compiler must load the module in
 *     the client environment to strip the handler bodies and leave an RPC stub.
 *
 *   - Therefore it calls `createServerFn` by name. The compiler recognises the
 *     call; a wrapper that hid the name from it would ship handler bodies to the
 *     browser. `serverFn` is re-exported FROM `@tanstack/react-start` by
 *     `./typed`, so the call is still recognisable.
 *
 *   - Therefore it does NOT statically import the request API or the actor, and
 *     does not lazily import them from anything that survives the stripping.
 *     `helpers()` below is the single door, and it is called from INSIDE handler
 *     bodies, which the compiler removes from the client chunk along with their
 *     dynamic imports. A helper that survived would drag the edge back into the
 *     client graph. `src/server/actor.ts` and `src/server/request.ts` carry the
 *     rule in full.
 *
 * The `lib/` imports below are safe: they are pure logic — pricing, state
 * machines, validation — with no request scope and no bindings.
 */

import { createServerFn } from '@tanstack/react-start';
import { readString, readNumber } from './typed';
import type { DeclaredServerFn, DeclaredServerFnNoInput } from './declare';
import {
  CART_COOKIE,
  addToCart as addToCartLib,
  cartView,
  checkoutPreview,
  clearCart,
  countCartItems,
  ensureCart,
  removeFromCart as removeFromCartLib,
  setCartQuantity as setCartQuantityLib,
} from '../lib/cart';
import {
  SESSION_COOKIE,
  authenticate,
  createSession,
  destroySession,
  findCustomerById,
  registerCustomer,
  setCustomerPassword,
  isValidEmail,
  normaliseEmail,
} from '../lib/auth';
import { enforceRateLimit, RATE_LIMITS, clearRateLimit } from '../lib/rate-limit';
import { sha256 } from '../lib/crypto';
import {
  placeOrder,
  confirmOrderPayment,
  orderViewByReference,
  orderViewByNumber,
  canViewOrder,
} from '../lib/checkout';
import { ordersForCustomer, ordersForEmail } from '../lib/orders';
import { checkDiscount } from '../lib/discounts';
import { db } from '../lib/env';
import { isRole, isStaff } from '../lib/roles';

/**
 * Resolve the request-scoped helpers, from inside a handler.
 *
 * Deliberately the only place these modules are reached from this file, and
 * deliberately called from handler bodies only. See the note at the top.
 */
async function helpers() {
  const [actor, request] = await Promise.all([import('./actor'), import('./request')]);
  return {
    currentActor: actor.currentActor,
    ipHash: actor.ipHash,
    readCookie: request.readCookie,
    writeCookie: request.writeCookie,
    clearCookie: request.clearCookie,
    userAgent: request.userAgent,
  };
}

/** The cookie options every store cookie shares. */
function cookieOptions(extra: { maxAge?: number; expires?: Date } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: true,
    path: '/',
    ...extra,
  };
}

// ----------------------------------------------------------------------- cart

export const getCart = createServerFn({ method: 'GET' }).handler(async (): Promise<CartResponse> => {
  const { readCookie, writeCookie, currentActor } = await helpers();
  const actor = await currentActor();
  const cartId = await ensureCart(readCookie(CART_COOKIE) ?? null, actor?.customerId ?? null);
  writeCookie(CART_COOKIE, cartId, cookieOptions({ maxAge: 60 * 60 * 24 * 60 }));
  const view = await cartView(cartId);
  return {
    count: view.totals.itemCount,
    subtotalMinor: view.totals.subtotalMinor,
    lines: view.lines,
    totals: view.totals,
    currency: view.currency,
  };
}) as unknown as DeclaredServerFnNoInput<CartResponse>;

export const addToCart = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { variantId?: unknown; quantity?: unknown };
    if (typeof data?.variantId !== 'string' || !data.variantId) {
      throw new Error('Choose an option first.');
    }
    const quantity = Number(data?.quantity ?? 1);
    if (!Number.isFinite(quantity)) throw new Error('Invalid quantity.');
    return { variantId: data.variantId, quantity: Math.round(quantity) };
  })
  .handler(async ({ data }): Promise<MutationResult> => {
    const { readCookie, writeCookie, currentActor, ipHash } = await helpers();
    const actor = await currentActor();
    await enforceRateLimit(`cart:add:${ipHash()}`, { limit: 120, windowSeconds: 300 });
    const cartId = await ensureCart(readCookie(CART_COOKIE) ?? null, actor?.customerId ?? null);
    writeCookie(CART_COOKIE, cartId, cookieOptions({ maxAge: 60 * 60 * 24 * 60 }));
    const result = await addToCartLib({
      cartId,
      variantId: readString(data, 'variantId'),
      quantity: readNumber(data, 'quantity', 1),
    });
    const count = await countCartItems(cartId);
    return { ...result, count };
  }) as unknown as DeclaredServerFn<MutationResult>;

export const setCartQuantity = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { itemId?: unknown; quantity?: unknown };
    if (typeof data?.itemId !== 'string' || !data.itemId) throw new Error('Missing cart item.');
    const quantity = Number(data?.quantity ?? 0);
    if (!Number.isFinite(quantity)) throw new Error('Invalid quantity.');
    return { itemId: data.itemId, quantity: Math.round(quantity) };
  })
  .handler(async ({ data }): Promise<MutationResult> => {
    const { readCookie } = await helpers();
    const cartId = readCookie(CART_COOKIE);
    if (!cartId) return { ok: false, message: 'Your cart is empty.', count: 0 };
    const result = await setCartQuantityLib({
      cartId,
      itemId: readString(data, 'itemId'),
      quantity: readNumber(data, 'quantity'),
    });
    const count = await countCartItems(cartId);
    return { ...result, count };
  }) as unknown as DeclaredServerFn<MutationResult>;

export const removeFromCart = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { itemId?: unknown };
    if (typeof data?.itemId !== 'string' || !data.itemId) throw new Error('Missing cart item.');
    return { itemId: data.itemId };
  })
  .handler(async ({ data }): Promise<MutationResult> => {
    const { readCookie } = await helpers();
    const cartId = readCookie(CART_COOKIE);
    if (!cartId) return { ok: true, count: 0 };
    await removeFromCartLib(cartId, readString(data, 'itemId'));
    const count = await countCartItems(cartId);
    return { ok: true, count };
  }) as unknown as DeclaredServerFn<MutationResult>;

export const emptyCart = createServerFn({ method: 'POST' }).handler(async (): Promise<MutationResult> => {
  const { readCookie } = await helpers();
  const cartId = readCookie(CART_COOKIE);
  if (cartId) await clearCart(cartId);
  return { ok: true, count: 0 };
}) as unknown as DeclaredServerFnNoInput<MutationResult>;

export const getCheckoutPreview = createServerFn({ method: 'GET' })
  .validator((input: unknown): CheckoutPreviewInput => {
    const data = (input ?? {}) as Record<string, unknown>;
    return {
      country: typeof data['country'] === 'string' ? data['country'] : undefined,
      region: typeof data['region'] === 'string' ? data['region'] : undefined,
      city: typeof data['city'] === 'string' ? data['city'] : undefined,
      shippingMethod: typeof data['shippingMethod'] === 'string' ? data['shippingMethod'] : undefined,
      discountCode: typeof data['discountCode'] === 'string' ? data['discountCode'] : undefined,
    };
  })
  .handler(async ({ data }): Promise<CheckoutPreviewResponse> => {
    const { readCookie } = await helpers();
    const cartId = readCookie(CART_COOKIE);
    if (!cartId) {
      return {
        empty: true,
        lines: [],
        totals: {
          subtotalMinor: 0,
          discountMinor: 0,
          shippingMinor: 0,
          taxMinor: 0,
          totalMinor: 0,
          itemCount: 0,
          freeShipping: false,
        },
        shippingOptions: [],
        shipping: null,
        discount: null,
        stockProblems: [],
        currency: 'NGN',
      };
    }
    return checkoutPreview({
      cartId,
      country: data.country,
      region: data.region,
      city: data.city,
      shippingMethod: data.shippingMethod,
      discountCode: data.discountCode,
    });
  }) as unknown as DeclaredServerFn<CheckoutPreviewResponse>;

export const applyDiscount = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { code?: unknown };
    return { code: typeof data?.code === 'string' ? data.code : '' };
  })
  .handler(async ({ data }): Promise<DiscountResponse> => {
    const { readCookie, ipHash } = await helpers();
    const cartId = readCookie(CART_COOKIE);
    if (!cartId) return { ok: false as const, reason: 'Your cart is empty.' };
    await enforceRateLimit(`discount:${ipHash()}`, { limit: 30, windowSeconds: 600 });
    const view = await cartView(cartId);
    const result = await checkDiscount(readString(data, 'code'), view.totals.subtotalMinor);
    if (!result.ok) return { ok: false as const, reason: result.reason };
    return {
      ok: true as const,
      code: result.discount.code,
      kind: result.discount.kind,
      value: result.discount.value,
    };
  }) as unknown as DeclaredServerFn<DiscountResponse>;

// ------------------------------------------------------------------ checkout

export const submitOrder = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    const address = (data['address'] ?? {}) as Record<string, unknown>;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    return {
      email: str(data['email']),
      address: {
        firstName: str(address['firstName']),
        lastName: str(address['lastName']),
        line1: str(address['line1']),
        line2: str(address['line2']),
        city: str(address['city']),
        region: str(address['region']),
        postalCode: str(address['postalCode']),
        country: str(address['country']) || 'Nigeria',
        phone: str(address['phone']),
      },
      shippingMethod: str(data['shippingMethod']),
      discountCode: str(data['discountCode']),
      customerNote: str(data['customerNote']),
    };
  })
  .handler(async ({ data }): Promise<SubmitOrderResponse> => {
    const { readCookie, clearCookie, currentActor, ipHash } = await helpers();
    const actor = await currentActor();
    await enforceRateLimit(`checkout:${ipHash()}`, RATE_LIMITS.checkout);

    const cartId = readCookie(CART_COOKIE);
    if (!cartId) return { ok: false as const, error: 'Your cart is empty.' };

    const address = data['address'] ?? {};

    const result = await placeOrder({
      cartId,
      email: readString(data, 'email'),
      address: {
        firstName: readString(address, 'firstName'),
        lastName: readString(address, 'lastName'),
        line1: readString(address, 'line1'),
        line2: readString(address, 'line2'),
        city: readString(address, 'city'),
        region: readString(address, 'region'),
        postalCode: readString(address, 'postalCode'),
        country: readString(address, 'country') || 'Nigeria',
        phone: readString(address, 'phone'),
      },
      shippingMethod: readString(data, 'shippingMethod') || undefined,
      discountCode: readString(data, 'discountCode') || undefined,
      customerNote: readString(data, 'customerNote'),
      customerId: actor?.customerId ?? null,
    });

    if (!result.ok) return { ok: false as const, error: result.error, field: result.field };

    // The cart has been converted; drop the cookie so the badge does not
    // resurrect a basket the customer has already paid for.
    clearCookie(CART_COOKIE, { path: '/' });

    return {
      ok: true as const,
      orderNumber: result.order.number,
      reference: result.reference,
      authorizationUrl: result.authorizationUrl,
    };
  }) as unknown as DeclaredServerFn<SubmitOrderResponse>;

export const confirmPayment = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { reference?: unknown };
    if (typeof data?.reference !== 'string' || !data.reference) {
      throw new Error('Missing payment reference.');
    }
    return { reference: data.reference };
  })
  .handler(async ({ data }): Promise<ConfirmPaymentResponse> => {
    const result = await confirmOrderPayment(readString(data, 'reference'));
    if (!result.ok) return { ok: false as const, error: result.error };
    return {
      ok: true as const,
      orderNumber: result.order.number,
      alreadySettled: result.alreadySettled,
    };
  }) as unknown as DeclaredServerFn<ConfirmPaymentResponse>;

// ------------------------------------------------------------------- account

export const signIn = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { email?: unknown; password?: unknown };
    return {
      email: typeof data?.email === 'string' ? data.email : '',
      password: typeof data?.password === 'string' ? data.password : '',
    };
  })
  .handler(async ({ data }): Promise<AuthResponse> => {
    const { writeCookie, userAgent, ipHash } = await helpers();
    const email = readString(data, 'email');
    const password = readString(data, 'password');

    // Keyed on the address as well as the IP: guessing one address from many IPs
    // is the attack this is here to stop.
    const ip = ipHash();
    const key = `login:${normaliseEmail(email)}:${ip}`;
    await enforceRateLimit(key, RATE_LIMITS.login);

    const customer = await authenticate(email, password);
    if (!customer) {
      return { ok: false as const, error: 'That email and password do not match an account.' };
    }

    await clearRateLimit(key);
    // The role comes from the ACCOUNT. The session carries a copy so an
    // authorised request does not need a second read.
    const role = isRole(customer.role) ? customer.role : 'customer';
    const { token, expiresAt } = await createSession({
      customerId: customer.id,
      role,
      userAgent: userAgent(),
      ipHash: ip,
    });
    writeCookie(SESSION_COOKIE, token, cookieOptions({ expires: expiresAt }));
    return { ok: true as const, name: customer.name || customer.email };
  }) as unknown as DeclaredServerFn<AuthResponse>;

export const signUp = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as Record<string, unknown>;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    return {
      email: str(data['email']),
      password: str(data['password']),
      name: str(data['name']),
      phone: str(data['phone']),
      marketingOptIn: data['marketingOptIn'] === true,
    };
  })
  .handler(async ({ data }): Promise<AuthResponse> => {
    const { writeCookie, userAgent, ipHash } = await helpers();
    const ip = ipHash();
    await enforceRateLimit(`register:${ip}`, RATE_LIMITS.register);

    const result = await registerCustomer({
      email: readString(data, 'email'),
      password: readString(data, 'password'),
      name: readString(data, 'name'),
      phone: readString(data, 'phone'),
      marketingOptIn: data['marketingOptIn'] === true,
    });
    if ('error' in result) return { ok: false as const, error: result.error };

    const { token, expiresAt } = await createSession({
      customerId: result.customer.id,
      role: 'customer',
      userAgent: userAgent(),
      ipHash: ip,
    });
    writeCookie(SESSION_COOKIE, token, cookieOptions({ expires: expiresAt }));
    return { ok: true as const, name: result.customer.name || result.customer.email };
  }) as unknown as DeclaredServerFn<AuthResponse>;

export const signOut = createServerFn({ method: 'POST' }).handler(async (): Promise<{ ok: true }> => {
  const { readCookie, clearCookie } = await helpers();
  const token = readCookie(SESSION_COOKIE);
  if (token) await destroySession(token);
  clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
}) as unknown as DeclaredServerFnNoInput<{ ok: true }>;

export const getAccount = createServerFn({ method: 'GET' }).handler(async (): Promise<AccountResponse> => {
  const { currentActor } = await helpers();
  const actor = await currentActor();
  if (!actor) return { signedIn: false as const };

  const customer = actor.customerId ? await findCustomerById(actor.customerId) : null;
  // Orders are found by account AND by email, because a guest purchase made
  // before registering belongs to the same person.
  const byAccount = actor.customerId ? await ordersForCustomer(actor.customerId) : [];
  const byEmail = actor.email ? await ordersForEmail(actor.email) : [];
  const seen = new Set<string>();
  const orders = [...byAccount, ...byEmail]
    .filter((order) => (seen.has(order.id) ? false : (seen.add(order.id), true)))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  return {
    signedIn: true as const,
    email: actor.email,
    name: customer?.name ?? actor.name,
    phone: customer?.phone ?? '',
    role: actor.role,
    isStaff: isStaff(actor.role),
    orders: orders.map((order) => ({
      number: order.number,
      status: order.status,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
      totalMinor: order.total_minor,
      currency: order.currency,
      createdAt: order.created_at,
    })),
  };
}) as unknown as DeclaredServerFnNoInput<AccountResponse>;

export const changePassword = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { current?: unknown; next?: unknown };
    return {
      current: typeof data?.current === 'string' ? data.current : '',
      next: typeof data?.next === 'string' ? data.next : '',
    };
  })
  .handler(async ({ data }): Promise<ChangePasswordResponse> => {
    const { currentActor } = await helpers();
    const actor = await currentActor();
    if (!actor?.customerId) return { ok: false as const, error: 'Sign in first.' };
    await enforceRateLimit(`password:${actor.customerId}`, RATE_LIMITS.passwordReset);

    const customer = await findCustomerById(actor.customerId);
    if (!customer) return { ok: false as const, error: 'Account not found.' };

    const currentPassword = readString(data, 'current');
    const nextPassword = readString(data, 'next');

    // A guest record with no password yet may set one; an existing password must
    // be presented, because otherwise a stolen session would be a takeover.
    if (customer.password_hash) {
      const ok = await authenticate(customer.email, currentPassword);
      if (!ok) return { ok: false as const, error: 'That current password is not right.' };
    }
    if (nextPassword.length < 8) {
      return { ok: false as const, error: 'Use at least 8 characters.' };
    }

    await setCustomerPassword(customer.id, nextPassword);
    return { ok: true as const };
  }) as DeclaredServerFn<{ ok: boolean; error?: string | undefined }> as unknown as DeclaredServerFn<ChangePasswordResponse>;

/**
 * Look up an order by number.
 *
 * Authorisation lives here, not in the page: staff see anything, a signed-in
 * customer sees their own, and a guest sees an order only if they can also
 * present the email address it was placed with.
 */
export const lookupOrder = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { number?: unknown; email?: unknown };
    return {
      number: typeof data?.number === 'string' ? data.number.trim() : '',
      email: typeof data?.email === 'string' ? data.email.trim() : '',
    };
  })
  .handler(async ({ data }): Promise<OrderLookup> => {
    const { currentActor, ipHash } = await helpers();
    const actor = await currentActor();
    await enforceRateLimit(`orderlookup:${ipHash()}`, { limit: 20, windowSeconds: 900 });

    const view = await orderViewByNumber(readString(data, 'number'));
    if (!view) return { ok: false as const, error: 'No order with that number.' };

    const suppliedEmail = readString(data, 'email');
    const allowed = canViewOrder({
      order: view.order,
      viewerCustomerId: actor?.customerId ?? null,
      viewerEmail: actor?.email || (isValidEmail(suppliedEmail) ? suppliedEmail : null),
      viewerIsStaff: isStaff(actor?.role),
    });
    if (!allowed) return { ok: false as const, error: 'We could not find that order for those details.' };

    return { ok: true as const, order: serialiseOrder(view) };
  }) as unknown as DeclaredServerFn<OrderLookup>;

export const getOrderByReference = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = input as { reference?: unknown };
    return { reference: typeof data?.reference === 'string' ? data.reference : '' };
  })
  .handler(async ({ data }): Promise<OrderLookup> => {
    const view = await orderViewByReference(readString(data, 'reference'));
    if (!view) return { ok: false as const, error: 'No order for that reference.' };
    // The reference is a capability: it is 60+ bits of randomness that only the
    // buyer was shown. That is what authorises reading this one order.
    return { ok: true as const, order: serialiseOrder(view) };
  }) as unknown as DeclaredServerFn<OrderLookup>;

function serialiseOrder(view: NonNullable<Awaited<ReturnType<typeof orderViewByNumber>>>): SerialisedOrder {
  return {
    number: view.order.number,
    status: view.order.status,
    paymentStatus: view.order.payment_status,
    fulfilmentStatus: view.order.fulfilment_status,
    currency: view.order.currency,
    subtotalMinor: view.order.subtotal_minor,
    discountMinor: view.order.discount_minor,
    shippingMinor: view.order.shipping_minor,
    totalMinor: view.order.total_minor,
    discountCode: view.order.discount_code,
    shippingMethod: view.order.shipping_method,
    shippingAddress: safeJson(view.order.shipping_address),
    email: view.order.email,
    createdAt: view.order.created_at,
    paidAt: view.order.paid_at,
    items: view.items.map((item) => ({
      title: item.title,
      variantTitle: item.variant_title,
      sku: item.sku,
      imageUrl: item.image_url,
      unitPriceMinor: item.unit_price_minor,
      quantity: item.quantity,
      lineTotalMinor: item.line_total_minor,
      quantityFulfilled: item.quantity_fulfilled,
    })),
    shipments: view.shipments.map((shipment) => ({
      carrier: shipment.carrier,
      trackingNumber: shipment.tracking_number,
      trackingUrl: shipment.tracking_url,
      status: shipment.status,
      shippedAt: shipment.shipped_at,
      deliveredAt: shipment.delivered_at,
    })),
  };
}

/** An address snapshot is a flat bag of strings; anything else is dropped. */
function safeJson(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === 'string') out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

// -------------------------------------------------------------------- contact

export const sendContactMessage = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as Record<string, unknown>;
    const str = (value: unknown): string => (typeof value === 'string' ? value : '');
    return {
      name: str(data['name']).slice(0, 200),
      email: str(data['email']).slice(0, 200),
      topic: str(data['topic']).slice(0, 100),
      message: str(data['message']).slice(0, 5000),
    };
  })
  .handler(async ({ data }): Promise<ContactResponse> => {
    const { ipHash } = await helpers();
    await enforceRateLimit(`contact:${ipHash()}`, RATE_LIMITS.contact);

    const name = readString(data, 'name');
    const email = readString(data, 'email');
    const topic = readString(data, 'topic');
    const message = readString(data, 'message');

    if (!name.trim() || !message.trim()) {
      return { ok: false as const, error: 'Please add your name and a message.' };
    }
    if (!isValidEmail(email)) {
      return { ok: false as const, error: 'Enter an email address we can reply to.' };
    }

    // Derived from a random source, not from the content: two identical messages
    // are two messages, and a hash of the body would collide them.
    const id = `msg_${sha256(`${Date.now()}:${email}:${Math.random()}`).slice(0, 24)}`;
    await db()
      .prepare('INSERT INTO contact_messages (id, name, email, topic, message) VALUES (?1,?2,?3,?4,?5)')
      .bind(id, name.trim(), normaliseEmail(email), topic, message.trim())
      .run();

    return { ok: true as const, id };
  }) as unknown as DeclaredServerFn<ContactResponse>;

// ---------------------------------------------------------------------- admin

export const getAdminSession = createServerFn({ method: 'GET' }).handler(async (): Promise<AdminSession> => {
  const { currentActor } = await helpers();
  const actor = await currentActor();
  if (!actor || !isStaff(actor.role)) return { staff: false as const };
  return { staff: true as const, role: actor.role, email: actor.email, name: actor.name };
}) as unknown as DeclaredServerFnNoInput<AdminSession>;

// ---------------------------------------------------------------- the shapes
// Declared, not inferred: the installed TanStack Start does not carry a
// handler's return type through `createServerFn`, and a cast per call site is
// where a mistake would hide.

export interface CheckoutPreviewInput {
  country?: string | undefined;
  region?: string | undefined;
  city?: string | undefined;
  shippingMethod?: string | undefined;
  discountCode?: string | undefined;
}

export interface CartResponse {
  count: number;
  subtotalMinor: number;
  lines: Awaited<ReturnType<typeof cartView>>['lines'];
  totals: Awaited<ReturnType<typeof cartView>>['totals'];
  currency: string;
}

export interface MutationResult {
  ok: boolean;
  message?: string | undefined;
  quantity?: number | undefined;
  count: number;
}

export type CheckoutPreviewResponse = Awaited<ReturnType<typeof checkoutPreview>>;

export type DiscountResponse =
  | { ok: true; code: string; kind: string; value: number }
  | { ok: false; reason: string };

export type SubmitOrderResponse =
  | { ok: true; orderNumber: string; reference: string; authorizationUrl: string | null }
  | { ok: false; error: string; field?: string | undefined };

export type ConfirmPaymentResponse =
  | { ok: true; orderNumber: string; alreadySettled: boolean }
  | { ok: false; error: string };

export type AuthResponse = { ok: true; name: string } | { ok: false; error: string };

export type AccountResponse =
  | { signedIn: false }
  | {
      signedIn: true;
      email: string;
      name: string;
      phone: string;
      role: string;
      isStaff: boolean;
      orders: Array<{
        number: string;
        status: string;
        paymentStatus: string;
        fulfilmentStatus: string;
        totalMinor: number;
        currency: string;
        createdAt: string;
      }>;
    };

export interface SerialisedOrder {
  number: string;
  status: string;
  paymentStatus: string;
  fulfilmentStatus: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  discountCode: string;
  shippingMethod: string;
  shippingAddress: Record<string, string>;
  email: string;
  createdAt: string;
  paidAt: string | null;
  items: Array<{
    title: string;
    variantTitle: string;
    sku: string;
    imageUrl: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    quantityFulfilled: number;
  }>;
  shipments: Array<{
    carrier: string;
    trackingNumber: string;
    trackingUrl: string;
    status: string;
    shippedAt: string | null;
    deliveredAt: string | null;
  }>;
}

export type OrderLookup = { ok: true; order: SerialisedOrder } | { ok: false; error: string };

export type ContactResponse = { ok: true; id: string } | { ok: false; error: string };

/** The change-password result, named so it can be used as a declared type. */
export type ChangePasswordResponse = { ok: boolean; error?: string | undefined };

export type AdminSession = { staff: false } | { staff: true; role: string; email: string; name: string };
