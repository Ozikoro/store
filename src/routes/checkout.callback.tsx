import { createFileRoute, Link } from '@tanstack/react-router';
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import { StoreLayout } from '@/store/layout';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/money';
import { getPaymentConfirmation } from '@/server/confirmation';

/**
 * Where Paystack sends the customer back.
 *
 * Nothing in this URL is believed. The `reference` selects which payment to
 * ask Paystack about, and the answer to that question is what this page shows —
 * a customer cannot reach a "paid" screen by typing a URL, because the screen is
 * drawn from the gateway's answer, not from the query string.
 */
export const Route = createFileRoute('/checkout/callback')({
  staticData: {
    seo: {
      title: 'Order confirmation',
      description: 'Your Ozikoro Store order confirmation.',
      kind: 'private',
      noindex: true,
    },
  },
  /**
   * Only the keys that actually carry a value.
   *
   * This returned `{ reference: '', trxref: '' }` for anything missing, and
   * TanStack SERIALISES every key the validator returns back into the URL. So a
   * callback missing either one was redirected once to a URL that added
   * `trxref=` — and Paystack's real return URL is
   * `/checkout/callback?trxref=…&reference=…`, which means the customer's own
   * confirmation link bounced before it rendered.
   *
   * Returning an empty object for an absent key keeps the search object equal to
   * the URL, which is what stops the redirect. It is the same fault that made
   * `/account?next=` need fixing, and the rule is worth stating: a search
   * validator must not invent keys.
   */
  validateSearch: (search: Record<string, unknown>): { reference?: string; trxref?: string } => {
    const out: { reference?: string; trxref?: string } = {};
    if (typeof search['reference'] === 'string' && search['reference']) out.reference = search['reference'];
    if (typeof search['trxref'] === 'string' && search['trxref']) out.trxref = search['trxref'];
    return out;
  },
  loaderDeps: ({ search }: { search: { reference?: string; trxref?: string } }) => ({
    reference: search.reference || search.trxref || '',
  }),
  loader: async ({ deps }) => {
    if (!deps.reference) return { state: 'missing' as const };
    return getPaymentConfirmation({ data: { reference: deps.reference } });
  },
  component: Confirmation,
});

function Confirmation() {
  const result = Route.useLoaderData();

  return (
    <StoreLayout minimal>
      <div className="site-container max-w-3xl py-16">
        {result.state === 'missing' && (
          <Panel
            icon={<XCircle className="text-destructive" size={28} />}
            title="We could not find that payment"
            body="The link is missing its payment reference. If you have just paid, check your email for the confirmation, or contact us with the order number."
          />
        )}

        {result.state === 'error' && (
          <Panel
            icon={<XCircle className="text-destructive" size={28} />}
            title="We could not confirm that payment"
            body={result.message}
          />
        )}

        {result.state === 'paid' && (
          <>
            <Panel
              icon={<CheckCircle2 className="text-primary-strong" size={28} />}
              title={`Thank you — order ${result.order.number} is confirmed`}
              body={`We have received your payment of ${formatMoney(result.order.totalMinor, result.order.currency)} and emailed a confirmation to ${result.order.email}.`}
            />
            <OrderSummary order={result.order} />
            <div className="mt-8 flex flex-wrap gap-4">
              <Button asChild>
                <Link to="/shop">Continue shopping</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/account">View your orders</Link>
              </Button>
            </div>
          </>
        )}

        {result.state === 'pending' && (
          <>
            <Panel
              icon={<Clock className="text-primary-strong" size={28} />}
              title={`Order ${result.order.number} is awaiting payment`}
              body="Your bank has not confirmed the payment yet. If you completed it, this page will update shortly and your confirmation email will arrive. If you abandoned the payment, you can try again."
            />
            <OrderSummary order={result.order} />
            <div className="mt-8 flex flex-wrap gap-4">
              <Button asChild>
                <Link to="/checkout">Try payment again</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/contact">Contact us</Link>
              </Button>
            </div>
          </>
        )}

        {result.state === 'failed' && (
          <>
            <Panel
              icon={<XCircle className="text-destructive" size={28} />}
              title={`Payment for order ${result.order.number} did not complete`}
              body={result.message}
            />
            <OrderSummary order={result.order} />
            <div className="mt-8">
              <Button asChild>
                <Link to="/checkout">Try again</Link>
              </Button>
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground mt-10">
          Something wrong?{' '}
          <Link to="/contact" className="underline">
            Contact the store
          </Link>{' '}
          with your order number and we will sort it out.
        </p>
      </div>
    </StoreLayout>
  );
}

function Panel({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="border border-border p-8">
      <div className="flex items-start gap-4">
        {icon}
        <div>
          <h1 className="font-display text-3xl leading-tight" data-testid="confirmation-title">
            {title}
          </h1>
          <p className="text-muted-foreground mt-3 leading-relaxed">{body}</p>
        </div>
      </div>
    </div>
  );
}

interface SummaryOrder {
  number: string;
  email: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  shippingMinor: number;
  totalMinor: number;
  shippingAddress: Record<string, unknown>;
  items: Array<{ title: string; variantTitle: string; quantity: number; lineTotalMinor: number; imageUrl: string }>;
}

function OrderSummary({ order }: { order: SummaryOrder }) {
  const address = order.shippingAddress;
  return (
    <div className="mt-8 border-t border-border pt-8 grid sm:grid-cols-2 gap-8">
      <div>
        <h2 className="eyebrow mb-4">Delivering to</h2>
        <p className="text-sm leading-relaxed">
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
      </div>
      <div>
        <h2 className="eyebrow mb-4">Order total</h2>
        <div className="text-sm space-y-2">
          {order.items.map((item) => (
            <div key={`${item.title}-${item.variantTitle}`} className="flex justify-between gap-4">
              <span>
                {item.title}
                {item.variantTitle ? ` · ${item.variantTitle}` : ''} × {item.quantity}
              </span>
              <span>{formatMoney(item.lineTotalMinor, order.currency)}</span>
            </div>
          ))}
          <div className="flex justify-between border-t border-border pt-3">
            <span>Subtotal</span>
            <span>{formatMoney(order.subtotalMinor, order.currency)}</span>
          </div>
          {order.discountMinor > 0 && (
            <div className="flex justify-between">
              <span>Discount</span>
              <span>−{formatMoney(order.discountMinor, order.currency)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Shipping</span>
            <span>
              {order.shippingMinor === 0 ? 'Free' : formatMoney(order.shippingMinor, order.currency)}
            </span>
          </div>
          <div className="flex justify-between border-t border-border pt-3 font-semibold">
            <span>Total</span>
            <span data-testid="confirmation-total">{formatMoney(order.totalMinor, order.currency)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
