/**
 * A customer's own order.
 *
 * The authorisation is here, on the server, and it is the same rule the order
 * lookup uses: the account that owns the order, or the email it was placed with.
 * A 404 is returned for anything else, so the response does not confirm that a
 * sequential order number exists.
 */

import { createServerFn } from '@tanstack/react-start';
import { readString } from './typed';
import type { DeclaredServerFn } from './declare';
import { orderViewByNumber } from '../lib/checkout';
import { isStaff } from '../lib/roles';

export interface CustomerOrder {
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
  createdAt: string;
  shippingAddress: Record<string, unknown>;
  items: Array<{
    title: string;
    variantTitle: string;
    sku: string;
    imageUrl: string;
    quantity: number;
    quantityFulfilled: number;
    lineTotalMinor: number;
  }>;
  shipments: Array<{
    carrier: string;
    trackingNumber: string;
    trackingUrl: string;
    status: string;
  }>;
}

export const getOrderForCustomer = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = input as { number?: unknown };
    return { number: typeof data?.number === 'string' ? data.number : '' };
  })
  .handler((async ({ data }: { data: { number: string } }): Promise<OrderAccess> => {
    // Dynamic, because this module is in the client graph while the compiler
    // strips the handler: a static import would be analysed there, and the
    // request API it reaches is denied in that environment. See actor.ts.
    const { currentActor } = await import('./actor');
    const actor = await currentActor();
    if (!actor) return { ok: false };

    const view = await orderViewByNumber(readString(data, 'number'));
    if (!view) return { ok: false };

    const owns =
      (actor.customerId && view.order.customer_id === actor.customerId) ||
      (actor.email && view.order.email.toLowerCase() === actor.email.toLowerCase()) ||
      isStaff(actor.role);

    if (!owns) return { ok: false };

    let address: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(view.order.shipping_address);
      if (parsed && typeof parsed === 'object') address = parsed as Record<string, unknown>;
    } catch {
      // A malformed snapshot must not blank the page.
    }

    return {
      ok: true,
      order: {
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
        createdAt: view.order.created_at,
        shippingAddress: address,
        items: view.items.map((item) => ({
          title: item.title,
          variantTitle: item.variant_title,
          sku: item.sku,
          imageUrl: item.image_url,
          quantity: item.quantity,
          quantityFulfilled: item.quantity_fulfilled,
          lineTotalMinor: item.line_total_minor,
        })),
        shipments: view.shipments.map((shipment) => ({
          carrier: shipment.carrier,
          trackingNumber: shipment.tracking_number,
          trackingUrl: shipment.tracking_url,
          status: shipment.status,
        })),
      },
    };
  }) as never) as unknown as DeclaredServerFn<OrderAccess>;

export type OrderAccess = { ok: true; order: CustomerOrder } | { ok: false };
