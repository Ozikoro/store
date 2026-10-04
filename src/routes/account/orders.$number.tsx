import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ArrowLeft, Truck } from 'lucide-react';
import { StoreLayout, PageIntro, Notice } from '@/store/layout';
import { storeHead } from '@/store/head';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/money';
import { ORDER_STATUS_LABELS, type OrderStatus } from '@/lib/order-state';
import { getOrderForCustomer } from '@/server/account';

/**
 * One order, for the person who placed it.
 *
 * Authorisation happens in the loader on the server; the page never decides who
 * may look. If the order is not this customer's, the route 404s rather than
 * saying "not allowed", because "not allowed" confirms the order exists.
 */
export const Route = createFileRoute('/account/orders/$number')({
  loader: async ({ params }) => {
    const result = await getOrderForCustomer({ data: { number: params.number } });
    if (!result.ok) throw notFound();
    return result.order;
  },
  head: ({ loaderData }) =>
    storeHead({
      title: `Order ${loaderData?.number ?? ''}`,
      description: 'Track an Ozikoro Store order.',
      path: '/account',
    }),
  component: OrderDetail,
});

function OrderDetail() {
  const order = Route.useLoaderData();
  const placed = new Date(order.createdAt.replace(' ', 'T') + 'Z');
  const address = order.shippingAddress;

  return (
    <StoreLayout>
      <PageIntro eyebrow="Order" title={order.number} description={`Placed ${placed.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' })}`} />

      <div className="site-container border-t border-border pt-10">
        <div className="flex flex-wrap gap-6 items-center mb-8">
          <span className="text-xs uppercase tracking-widest font-semibold text-primary-strong" data-testid="order-status">
            {ORDER_STATUS_LABELS[order.status as OrderStatus] ?? order.status}
          </span>
          <span className="text-sm text-muted-foreground">
            {order.fulfilmentStatus === 'fulfilled'
              ? 'Packed'
              : order.fulfilmentStatus === 'partial'
                ? 'Partly packed'
                : order.status === 'paid'
                  ? 'Being prepared'
                  : ''}
          </span>
        </div>

        {order.status === 'pending' && (
          <div className="mb-8">
            <Notice tone="info">
              This order is awaiting payment and its items are held for you. If you did not complete the payment, you
              can place the order again from the shop.
            </Notice>
          </div>
        )}

        <div className="grid lg:grid-cols-[1fr_340px] gap-12">
          <div className="border-t border-border">
            {order.items.map((item) => (
              <div key={item.sku + item.title} className="flex gap-5 border-b border-border py-6">
                <img src={item.imageUrl} alt="" className="w-20 h-24 object-cover bg-secondary" />
                <div className="flex-1">
                  <p className="font-display text-xl">{item.title}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {item.variantTitle || '—'} · Qty {item.quantity}
                    {item.quantityFulfilled > 0 && ` · ${item.quantityFulfilled} packed`}
                  </p>
                </div>
                <p className="text-sm">{formatMoney(item.lineTotalMinor, order.currency)}</p>
              </div>
            ))}

            {order.shipments.length > 0 && (
              <div className="py-6 border-b border-border">
                <h2 className="font-display text-2xl mb-4 flex items-center gap-2">
                  <Truck size={18} className="text-primary-strong" aria-hidden /> Delivery
                </h2>
                {order.shipments.map((shipment) => (
                  <p key={shipment.trackingNumber} className="text-sm text-muted-foreground">
                    {shipment.carrier} · {shipment.trackingNumber} · {shipment.status}
                    {shipment.trackingUrl && (
                      <>
                        {' · '}
                        <a href={shipment.trackingUrl} target="_blank" rel="noreferrer" className="underline">
                          Track
                        </a>
                      </>
                    )}
                  </p>
                ))}
              </div>
            )}
          </div>

          <aside className="bg-secondary p-7 h-fit">
            <h2 className="font-display text-2xl mb-4">Summary</h2>
            <div className="text-sm space-y-2">
              <Row label="Subtotal" value={formatMoney(order.subtotalMinor, order.currency)} />
              {order.discountMinor > 0 && (
                <Row
                  label={`Discount${order.discountCode ? ` (${order.discountCode})` : ''}`}
                  value={`−${formatMoney(order.discountMinor, order.currency)}`}
                />
              )}
              <Row
                label="Shipping"
                value={order.shippingMinor === 0 ? 'Free' : formatMoney(order.shippingMinor, order.currency)}
              />
              <div className="flex justify-between border-t border-border pt-3 font-semibold">
                <span>Total</span>
                <span>{formatMoney(order.totalMinor, order.currency)}</span>
              </div>
            </div>

            <h2 className="font-display text-2xl mt-8 mb-3">Delivering to</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {String(address['firstName'] ?? '')} {String(address['lastName'] ?? '')}
              <br />
              {String(address['line1'] ?? '')}
              {address['line2'] ? (
                <>
                  <br />
                  {String(address['line2'])}
                </>
              ) : null}
              <br />
              {[address['city'], address['region'], address['postalCode']].filter(Boolean).join(', ')}
              <br />
              {String(address['country'] ?? '')}
              <br />
              {String(address['phone'] ?? '')}
            </p>

            <Button asChild variant="outline" className="w-full mt-8">
              <Link to="/account">
                <ArrowLeft size={14} /> All orders
              </Link>
            </Button>
          </aside>
        </div>
      </div>
    </StoreLayout>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
