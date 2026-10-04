import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight, Minus, Plus, Trash2 } from 'lucide-react';
import { StoreLayout, PageIntro, Notice } from '@/store/layout';
import { storeHead } from '@/store/head';
import { useCart } from '@/store/cart';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/money';

export const Route = createFileRoute('/cart')({
  head: () =>
    storeHead({
      title: 'Your cart',
      description: 'Review your selections from the Ozikoro Store.',
      path: '/cart',
    }),
  component: Cart,
});

function Cart() {
  const { cart, setQuantity, remove, busy, notice } = useCart();
  const lines = cart.lines;

  return (
    <StoreLayout>
      <PageIntro eyebrow="Your selection" title="Your cart" />

      {notice && (
        <div className="site-container pb-6">
          <Notice>{notice}</Notice>
        </div>
      )}

      {lines.length > 0 ? (
        <div className="site-container grid lg:grid-cols-[1fr_340px] gap-12">
          <div className="border-t border-border">
            {lines.map((line) => (
              <div key={line.itemId} className="flex gap-5 border-b border-border py-6" data-testid={`cart-line-${line.sku}`}>
                <Link
                  to="/products/$slug"
                  params={{ slug: line.productSlug }}
                  className="w-24 sm:w-32 shrink-0 aspect-[4/5] bg-secondary"
                >
                  <img src={line.imageUrl} alt={line.title} className="w-full h-full object-cover" />
                </Link>
                <div className="flex-1 min-w-0">
                  <p className="eyebrow">{line.title}</p>
                  <Link
                    to="/products/$slug"
                    params={{ slug: line.productSlug }}
                    className="font-display text-2xl block mt-1"
                  >
                    {line.variantTitle || line.title}
                  </Link>
                  <p className="text-xs text-muted-foreground mt-2">
                    {line.sku}
                    {line.availableStock !== null && ` · ${line.availableStock} in stock`}
                  </p>

                  {!line.isActive && (
                    <p className="text-xs text-destructive mt-2">
                      This item is no longer available and will not be ordered.
                    </p>
                  )}
                  {line.priceChanged && line.isActive && (
                    <p className="text-xs text-muted-foreground mt-2">
                      Price updated from {formatMoney(line.addedPriceMinor, cart.currency)} to{' '}
                      {formatMoney(line.unitPriceMinor, cart.currency)}.
                    </p>
                  )}

                  <div className="flex items-center gap-4 mt-5">
                    <div className="border border-border flex items-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Decrease quantity"
                        disabled={busy}
                        onClick={() => setQuantity(line.itemId, line.quantity - 1)}
                        data-testid={`decrease-${line.sku}`}
                      >
                        <Minus size={14} />
                      </Button>
                      <span className="w-8 text-center text-sm" data-testid={`quantity-${line.sku}`}>
                        {line.quantity}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Increase quantity"
                        disabled={busy}
                        onClick={() => setQuantity(line.itemId, line.quantity + 1)}
                        data-testid={`increase-${line.sku}`}
                      >
                        <Plus size={14} />
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Remove item"
                      aria-label={`Remove ${line.title}`}
                      disabled={busy}
                      onClick={() => remove(line.itemId)}
                      data-testid={`remove-${line.sku}`}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
                <p className="text-sm whitespace-nowrap">{formatMoney(line.lineTotalMinor, cart.currency)}</p>
              </div>
            ))}
          </div>

          <aside className="bg-secondary p-7 h-fit">
            <h2 className="font-display text-3xl">Order summary</h2>
            <div className="flex justify-between border-b border-border py-6 text-sm">
              <span>Subtotal</span>
              <strong data-testid="cart-subtotal">{formatMoney(cart.subtotalMinor, cart.currency)}</strong>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed mt-5">
              Shipping is calculated at checkout from your delivery address, and shown before you pay.
            </p>
            <Button asChild className="w-full h-12 mt-7" data-testid="checkout-link">
              <Link to="/checkout">
                Continue to checkout <ArrowRight size={16} />
              </Link>
            </Button>
            <Link to="/shop" className="block text-center text-xs underline mt-5">
              Continue shopping
            </Link>
          </aside>
        </div>
      ) : (
        <div className="site-container py-20 text-center border-t border-border">
          <p className="font-display text-3xl">Nothing here just yet.</p>
          <p className="text-muted-foreground mt-3">Explore the store and find something to take with you.</p>
          <Button asChild className="mt-8">
            <Link to="/shop">
              Shop all products <ArrowRight size={16} />
            </Link>
          </Button>
        </div>
      )}
    </StoreLayout>
  );
}
