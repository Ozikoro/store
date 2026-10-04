/**
 * The confirmation lookup.
 *
 * `confirmPayment` asks Paystack what happened and settles the order if it is
 * real. If it cannot — a network blip, or the money genuinely has not landed —
 * the page still needs to show something honest, so the order is read back and
 * classified rather than the customer being shown a blank error.
 *
 * The statuses are deliberately four and not two: "paid", "pending" (we could
 * not confirm yet, payment may still be in flight), "failed" (the gateway said
 * no) and "error" (we could not ask). Collapsing pending into failed is how a
 * store tells a paying customer their payment failed.
 */

import { confirmPayment } from './store';
import { orderViewByReference } from '../lib/checkout';
import { findPaymentByReference } from '../lib/orders';
import { createServerFn } from '@tanstack/react-start';
import type { DeclaredServerFn } from './declare';

export interface ConfirmationOrder {
  number: string;
  email: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  shippingAddress: Record<string, unknown>;
  items: Array<{
    title: string;
    variantTitle: string;
    quantity: number;
    lineTotalMinor: number;
    imageUrl: string;
  }>;
}

export type ConfirmationResult =
  | { state: 'missing' }
  | { state: 'error'; message: string }
  | { state: 'paid'; order: ConfirmationOrder }
  | { state: 'pending'; order: ConfirmationOrder }
  | { state: 'failed'; order: ConfirmationOrder; message: string };

function snapshot(view: NonNullable<Awaited<ReturnType<typeof orderViewByReference>>>): ConfirmationOrder {
  let address: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(view.order.shipping_address);
    if (parsed && typeof parsed === 'object') address = parsed as Record<string, unknown>;
  } catch {
    // A malformed address snapshot must not blank the confirmation page.
  }
  return {
    number: view.order.number,
    email: view.order.email,
    currency: view.order.currency,
    subtotalMinor: view.order.subtotal_minor,
    discountMinor: view.order.discount_minor,
    shippingMinor: view.order.shipping_minor,
    totalMinor: view.order.total_minor,
    shippingAddress: address,
    items: view.items.map((item) => ({
      title: item.title,
      variantTitle: item.variant_title,
      quantity: item.quantity,
      lineTotalMinor: item.line_total_minor,
      imageUrl: item.image_url,
    })),
  };
}

export const getPaymentConfirmation = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = input as { reference?: unknown };
    return { reference: typeof data?.reference === 'string' ? data.reference : '' };
  })
  .handler((async ({ data }: { data: { reference: string } }): Promise<ConfirmationResult> => {
    if (!data.reference) return { state: 'missing' };

    const view = await orderViewByReference(data.reference);
    if (!view) return { state: 'error', message: 'We have no record of that payment reference.' };

    // Already settled — the webhook usually wins this race, and re-asking the
    // gateway would be a wasted round trip.
    if (view.order.payment_status === 'paid' || view.order.payment_status === 'partially_refunded') {
      return { state: 'paid', order: snapshot(view) };
    }

    const result = await confirmPayment({ data: { reference: data.reference } });

    if (result.ok) return { state: 'paid', order: snapshot(view) };

    // Re-read: `confirmPayment` may have marked the payment failed.
    const payment = await findPaymentByReference(data.reference);
    const refreshed = await orderViewByReference(data.reference);
    const order = refreshed ? snapshot(refreshed) : snapshot(view);

    if (payment?.status === 'failed') {
      return { state: 'failed', order, message: result.error };
    }

    if (payment?.status === 'initialized' || payment?.status === 'pending') {
      return { state: 'pending', order };
    }

    return { state: 'error', message: result.error };
  }) as never) as unknown as DeclaredServerFn<ConfirmationResult>;
