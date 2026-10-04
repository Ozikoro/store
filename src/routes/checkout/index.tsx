import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, LockKeyhole, Loader2 } from 'lucide-react';
import { StoreLayout, Notice } from '@/store/layout';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/money';
import { getCheckoutPreview, submitOrder, getAccount } from '@/server/store';

export const Route = createFileRoute('/checkout/')({
  staticData: {
    seo: {
      title: 'Checkout',
      description: 'Delivery details and secure card payment for your Ozikoro Store order.',
      kind: 'private',
    },
  },
  loader: async () => {
    const [preview, account] = await Promise.all([
      getCheckoutPreview({ data: {} }),
      getAccount(),
    ]);
    return { preview, account };
  },
  component: Checkout,
});

type Country = 'Nigeria' | 'Other country';

function Checkout() {
  const initial = Route.useLoaderData();
  const navigate = useNavigate();

  const [country, setCountry] = useState<Country>(
    initial.account.signedIn ? 'Nigeria' : 'Nigeria'
  );
  const [city, setCity] = useState('');
  const [region, setRegion] = useState('');
  const [discountCode, setDiscountCode] = useState('');
  const [preview, setPreview] = useState(initial.preview);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Re-quote whenever the address changes. The shipping line the customer is
  // about to pay must reflect the address they actually typed.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const next = await getCheckoutPreview({
        data: {
          country: country === 'Nigeria' ? 'Nigeria' : 'International',
          city,
          region,
          discountCode,
        },
      });
      if (!cancelled) setPreview(next);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [country, city, region, discountCode]);

  const lines = preview.lines;
  const empty = lines.length === 0;
  const blocked = preview.stockProblems.length > 0;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError(null);
    setSubmitting(true);

    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '');

    try {
      const result = await submitOrder({
        data: {
          email: value('email'),
          address: {
            firstName: value('firstName'),
            lastName: value('lastName'),
            line1: value('line1'),
            line2: value('line2'),
            city: value('city'),
            region: value('region'),
            postalCode: value('postalCode'),
            country: country === 'Nigeria' ? 'Nigeria' : value('country') || 'International',
            phone: value('phone'),
          },
          shippingMethod: preview.shipping?.method ?? '',
          discountCode,
          customerNote: value('note'),
        },
      });

      if (!result.ok) {
        setError(result.error);
        setFieldError(result.field ?? null);
        setSubmitting(false);
        return;
      }

      if (result.authorizationUrl) {
        // A full navigation, not a router push: the customer is leaving the app
        // for the payment page, and the browser must not keep the form state.
        window.location.assign(result.authorizationUrl);
        return;
      }

      void navigate({ to: '/checkout/callback', search: { reference: result.reference, trxref: '' } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong. Please try again.');
      setSubmitting(false);
    }
  }

  return (
    <StoreLayout minimal>
      <div className="site-container max-w-[1100px] py-8">
        <Link to="/cart" className="text-xs flex items-center gap-2 text-muted-foreground">
          <ArrowLeft size={14} /> Return to cart
        </Link>

        <div className="mt-8 mb-9">
          <p className="eyebrow mb-3">Checkout</p>
          <h1 className="font-display text-5xl">Your details</h1>
          <p className="text-sm text-muted-foreground mt-3">
            Payment is taken on Paystack's secure page. We never see or store your card details.
          </p>
        </div>

        {empty ? (
          <div className="border-t border-border py-20">
            <p>Your cart is empty.</p>
            <Button asChild className="mt-6">
              <Link to="/shop">Browse the store</Link>
            </Button>
          </div>
        ) : (
          <div className="grid lg:grid-cols-[1fr_380px] gap-12 lg:gap-20">
            <div>
              <form onSubmit={onSubmit} noValidate>
                <h2 className="font-display text-3xl mb-6">Contact</h2>
                <label className="field-label" htmlFor="email">
                  Email address
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  className="field"
                  placeholder="you@example.com"
                  defaultValue={initial.account.signedIn ? initial.account.email : ''}
                  data-testid="checkout-email"
                />
                <p className="text-xs text-muted-foreground mt-2">
                  Your order confirmation goes here.
                </p>

                <h2 className="font-display text-3xl mt-10 mb-6">Delivery address</h2>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label className="field-label" htmlFor="first">
                      First name
                    </label>
                    <input id="first" name="firstName" required autoComplete="given-name" className="field" data-testid="checkout-first" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="last">
                      Last name
                    </label>
                    <input id="last" name="lastName" required autoComplete="family-name" className="field" data-testid="checkout-last" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="field-label" htmlFor="address">
                      Address
                    </label>
                    <input id="address" name="line1" required autoComplete="street-address" className="field" data-testid="checkout-line1" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="field-label" htmlFor="address2">
                      Apartment, suite, landmark (optional)
                    </label>
                    <input id="address2" name="line2" autoComplete="address-line2" className="field" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="city">
                      City
                    </label>
                    <input
                      id="city"
                      name="city"
                      required
                      autoComplete="address-level2"
                      className="field"
                      value={city}
                      onChange={(event) => setCity(event.target.value)}
                      data-testid="checkout-city"
                    />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="region">
                      State / region
                    </label>
                    <input
                      id="region"
                      name="region"
                      autoComplete="address-level1"
                      className="field"
                      value={region}
                      onChange={(event) => setRegion(event.target.value)}
                      data-testid="checkout-region"
                    />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="postal">
                      Postal code
                    </label>
                    <input id="postal" name="postalCode" autoComplete="postal-code" className="field" />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="country">
                      Country
                    </label>
                    <select
                      id="country"
                      name="country"
                      className="field"
                      value={country}
                      onChange={(event) => setCountry(event.target.value as Country)}
                      data-testid="checkout-country"
                    >
                      <option value="Nigeria">Nigeria</option>
                      <option value="Other country">Other country</option>
                    </select>
                  </div>
                  {country !== 'Nigeria' && (
                    <div className="sm:col-span-2">
                      <label className="field-label" htmlFor="countryName">
                        Which country?
                      </label>
                      <input id="countryName" name="country" className="field" data-testid="checkout-country-name" />
                    </div>
                  )}
                  <div className="sm:col-span-2">
                    <label className="field-label" htmlFor="phone">
                      Phone number
                    </label>
                    <input id="phone" name="phone" required autoComplete="tel" className="field" data-testid="checkout-phone" />
                  </div>
                </div>

                <label className="field-label mt-8" htmlFor="note">
                  Order note (optional)
                </label>
                <textarea id="note" name="note" rows={3} className="field h-auto py-3" />

                <div className="mt-9 p-5 border border-border text-sm">
                  <p className="font-semibold flex items-center gap-2">
                    <LockKeyhole size={15} /> Payment
                  </p>
                  <p className="text-muted-foreground mt-2 leading-relaxed">
                    You will be taken to Paystack to pay{' '}
                    <strong className="text-foreground" data-testid="checkout-total-inline">
                      {formatMoney(preview.totals.totalMinor, preview.currency)}
                    </strong>{' '}
                    by card, bank transfer or USSD. Your order is confirmed only once the payment is verified on our
                    server.
                  </p>
                </div>

                {error && (
                  <div className="mt-6">
                    <Notice>{error}</Notice>
                  </div>
                )}
                {fieldError && (
                  <p className="text-xs text-destructive mt-2">Check the {fieldError} field above.</p>
                )}

                <Button
                  type="submit"
                  className="w-full h-12 mt-7"
                  disabled={submitting || blocked}
                  data-testid="place-order"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} className="animate-spin" /> Starting secure payment…
                    </>
                  ) : (
                    <>
                      Pay {formatMoney(preview.totals.totalMinor, preview.currency)} <ArrowRight size={16} />
                    </>
                  )}
                </Button>

                {blocked && (
                  <p className="text-xs text-destructive mt-3" data-testid="checkout-stock-error">
                    {preview.stockProblems
                      .map((problem) =>
                        problem.available <= 0
                          ? `${problem.title} is out of stock.`
                          : `Only ${problem.available} of ${problem.title} left.`
                      )
                      .join(' ')}{' '}
                    <Link to="/cart" className="underline">
                      Update your cart
                    </Link>
                    .
                  </p>
                )}
              </form>
            </div>

            <aside className="bg-secondary p-7 h-fit">
              <h2 className="font-display text-3xl mb-6">Your order</h2>
              {lines.map((line) => (
                <div key={line.itemId} className="flex gap-4 mb-5">
                  <img src={line.imageUrl} alt="" className="w-16 h-20 object-cover" />
                  <div className="flex-1 text-sm">
                    <p className="font-semibold">{line.title}</p>
                    <p className="text-muted-foreground text-xs mt-1">
                      {line.variantTitle} · Qty {line.quantity}
                    </p>
                  </div>
                  <span className="text-xs whitespace-nowrap">
                    {formatMoney(line.lineTotalMinor, preview.currency)}
                  </span>
                </div>
              ))}

              <div className="border-t border-border mt-6 pt-5 flex justify-between text-sm">
                <span>Subtotal</span>
                <strong data-testid="summary-subtotal">{formatMoney(preview.totals.subtotalMinor, preview.currency)}</strong>
              </div>

              <div className="flex gap-2 mt-4">
                <label className="sr-only" htmlFor="discount">
                  Discount code
                </label>
                <input
                  id="discount"
                  className="field h-11"
                  placeholder="Discount code"
                  value={discountCode}
                  onChange={(event) => setDiscountCode(event.target.value)}
                  data-testid="discount-input"
                />
              </div>
              {preview.discount && !preview.discount.ok && (
                <p className="text-xs text-destructive mt-2">{preview.discount.reason}</p>
              )}
              {preview.discount && preview.discount.ok && (
                <p className="text-xs text-muted-foreground mt-2" data-testid="discount-applied">
                  {preview.discount.discount.code} applied.
                </p>
              )}

              {preview.totals.discountMinor > 0 && (
                <div className="flex justify-between py-3 text-sm text-primary-strong" data-testid="summary-discount">
                  <span>Discount</span>
                  <span>−{formatMoney(preview.totals.discountMinor, preview.currency)}</span>
                </div>
              )}

              <div className="border-b border-border py-4 flex justify-between text-sm" data-testid="summary-shipping">
                <span>Shipping</span>
                <span>
                  {preview.shipping
                    ? preview.shipping.amountMinor === 0
                      ? 'Free'
                      : formatMoney(preview.shipping.amountMinor, preview.currency)
                    : 'Enter your address'}
                </span>
              </div>

              {preview.shipping && (
                <p className="text-xs text-muted-foreground mt-3">{preview.shipping.estimate}</p>
              )}

              <div className="flex justify-between pt-5 text-base" data-testid="summary-total">
                <span className="font-semibold">Total</span>
                <strong>{formatMoney(preview.totals.totalMinor, preview.currency)}</strong>
              </div>

              <p className="text-xs mt-5 text-muted-foreground">
                Prices include everything shown. No charge is made until you complete payment.
              </p>
            </aside>
          </div>
        )}
      </div>
    </StoreLayout>
  );
}
