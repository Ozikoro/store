import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { useState } from 'react';
import { ArrowLeft, Check, Truck, RotateCcw, Minus, Plus } from 'lucide-react';
import { StoreLayout, Notice } from '@/store/layout';
import { NotFound } from '@/store/not-found';
import { ProductCard } from '@/store/product-card';
import { useCart } from '@/store/cart';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/lib/money';
import { parseDetails, isSoldOut } from '@/lib/catalog';
import { getProduct } from '@/server/catalog';
import { composeRouteHead } from '@/store/head-compose';
import type { ProductWithVariants } from '@/lib/catalog';

/**
 * The offer block for a product's structured data, from its live variants.
 *
 * `offerCount` is the number of active variants, because that is how many ways
 * there are to buy it — not one, which is what the store claimed before.
 */
function offersFor(product: ProductWithVariants) {
  const active = product.variants.filter((variant) => variant.is_active);
  const prices = active.map((variant) => variant.price_minor);
  return {
    currency: product.currency,
    lowPriceMinor: prices.length ? Math.min(...prices) : product.price_minor,
    highPriceMinor: prices.length ? Math.max(...prices) : product.price_minor,
    inStock: active.some((variant) => variant.stock > 0) || product.made_to_order === 1,
    sku: active[0]?.sku ?? product.slug,
  };
}

export const Route = createFileRoute('/products/$slug')({
  loader: async ({ params }) => {
    const result = await getProduct({ data: { slug: params.slug } });
    if (!result.found) throw notFound();
    return result;
  },
  /**
   * The product's head.
   *
   * The offer prices come from the REAL active variants, so the price in a
   * result is the price the store will charge. `availability` is derived from
   * live stock rather than assumed: telling a search engine something is in
   * stock when it is not is how a shop earns an "unavailable" reputation.
   */
  staticData: { ownsHead: true },
  head: (ctx) =>
    composeRouteHead({
      ctx,
      kind: 'product',
      fallbackTitle: 'Product',
      route: ctx.loaderData?.found
        ? {
            title: ctx.loaderData.product.seo_title || ctx.loaderData.product.title,
            description:
              ctx.loaderData.product.seo_description ||
              ctx.loaderData.product.description ||
              `${ctx.loaderData.product.title} from the Ozikoro Store.`,
            image: ctx.loaderData.product.image_url,
            imageAlt: ctx.loaderData.product.image_alt || ctx.loaderData.product.title,
            updated: ctx.loaderData.product.updated_at,
            reference: ctx.loaderData.product.variants.find((variant) => variant.is_active)?.sku ?? null,
            topics: [ctx.loaderData.product.category],
            trail: [
              { name: 'Shop', path: '/shop' },
              { name: ctx.loaderData.product.category, path: '/collections' },
              { name: ctx.loaderData.product.title, path: `/products/${ctx.loaderData.product.slug}` },
            ],
            offers: offersFor(ctx.loaderData.product),
          }
        : { title: 'Product not found', noindex: true },
    }),
  component: ProductPage,
  notFoundComponent: () => (
    <NotFound
      title="We could not find that piece."
      detail="It may have sold, or the address may be mistyped. Everything currently in the store is on the shop page."
    />
  ),
});

function ProductPage() {
  const { product, related } = Route.useLoaderData();
  const { add, busy, notice } = useCart();
  const [variantId, setVariantId] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  const [quantity, setQuantity] = useState(1);

  const active = product.variants.filter((variant) => variant.is_active);
  const selected = active.find((variant) => variant.id === variantId) ?? null;
  const cheapest = active.length ? Math.min(...active.map((variant) => variant.price_minor)) : product.price_minor;
  const dearest = active.length ? Math.max(...active.map((variant) => variant.price_minor)) : product.price_minor;
  const details = parseDetails(product.details);
  const soldOut = isSoldOut(product);
  const variantLabel = product.category === 'Apparel' ? 'Select size' : 'Select format';
  const blocked = selected ? selected.stock <= 0 && product.made_to_order !== 1 : false;

  async function onAdd() {
    if (!selected) {
      document.getElementById('variant-choice')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const ok = await add(selected.id, quantity);
    setAdded(ok);
  }

  return (
    <StoreLayout>

      <div className="site-container py-6">
        <Link
          to="/shop"
          className="inline-flex gap-2 items-center text-xs text-muted-foreground hover:text-primary-strong"
        >
          <ArrowLeft size={14} /> Back to shop
        </Link>
      </div>

      <div className="site-container grid md:grid-cols-2 gap-9 lg:gap-20">
        <div className="bg-secondary aspect-[4/5] overflow-hidden">
          <img
            src={product.image_url || '/media/print.jpg'}
            width={912}
            height={1104}
            alt={product.image_alt || product.title}
            className="w-full h-full object-cover"
          />
        </div>

        <div className="md:pt-8 max-w-xl">
          <p className="eyebrow mb-4">{product.category}</p>
          <h1 className="font-display text-5xl md:text-6xl leading-[1.02]">{product.title}</h1>

          <p className="text-xl mt-5" data-testid="product-price">
            {dearest > cheapest && !selected
              ? `from ${formatMoney(cheapest, product.currency)}`
              : formatMoney(selected ? selected.price_minor : cheapest, product.currency)}
          </p>

          <p className="text-muted-foreground mt-7 leading-relaxed">{product.description}</p>

          <p className="text-sm font-semibold mt-9 mb-3">{variantLabel}</p>
          <div id="variant-choice" className="flex flex-wrap gap-2">
            {active.map((variant) => {
              const out = variant.stock <= 0 && product.made_to_order !== 1;
              return (
                <Button
                  key={variant.id}
                  variant={variantId === variant.id ? 'choiceActive' : 'choice'}
                  disabled={out}
                  onClick={() => {
                    setVariantId(variant.id);
                    setAdded(false);
                    setQuantity(1);
                  }}
                  data-testid={`variant-${variant.sku}`}
                >
                  {variant.title}
                  {out ? ' — sold out' : ''}
                </Button>
              );
            })}
          </div>

          {selected && (
            <p className="text-xs text-muted-foreground mt-3" data-testid="variant-stock">
              {product.made_to_order === 1
                ? 'Made to order — allow 2–4 weeks before dispatch.'
                : selected.stock > 0
                  ? `${selected.stock} in stock`
                  : 'Out of stock'}
              {' · '}SKU {selected.sku}
            </p>
          )}

          {product.category === 'Apparel' && (
            <details className="text-xs mt-3 text-muted-foreground">
              <summary className="cursor-pointer underline">Size guide</summary>
              <p className="mt-2">
                Relaxed unisex fit. Choose your usual size for an easy fit, or size down for a closer fit.
              </p>
            </details>
          )}

          <div className="flex items-center gap-4 mt-8">
            <div className="border border-border flex items-center">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Decrease quantity"
                onClick={() => setQuantity((value) => Math.max(1, value - 1))}
              >
                <Minus size={14} />
              </Button>
              <span className="w-8 text-center text-sm" data-testid="quantity">
                {quantity}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Increase quantity"
                onClick={() => setQuantity((value) => Math.min(25, value + 1))}
              >
                <Plus size={14} />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {soldOut ? 'Currently sold out.' : selected ? 'Ready to add to your cart.' : 'Choose an option to continue.'}
            </p>
          </div>

          {notice && (
            <div className="mt-5">
              <Notice>{notice}</Notice>
            </div>
          )}

          <Button
            className="w-full h-12 mt-4"
            disabled={busy || soldOut || blocked}
            onClick={onAdd}
            data-testid="add-to-cart"
          >
            {added ? 'Added to cart' : soldOut ? 'Sold out' : 'Add to cart'}
            {added && <Check size={16} />}
          </Button>
          {added && (
            <Link to="/cart" className="text-sm inline-block mt-3 underline" data-testid="view-cart-link">
              View cart
            </Link>
          )}

          <div className="border-t border-border mt-10">
            {[
              { title: 'Details & materials', content: details.join(' · ') || 'Details to follow.' },
              {
                title: 'Shipping & returns',
                content:
                  'Shipping is quoted at checkout and confirmed before payment. Lagos delivery is 1–3 working days, nationwide 3–7. See our shipping and returns page for the full policy.',
              },
            ].map((section) => (
              <details key={section.title} className="border-b border-border py-5 group">
                <summary className="cursor-pointer text-sm font-semibold list-none flex justify-between">
                  <span>{section.title}</span>
                  <span>+</span>
                </summary>
                <p className="text-sm leading-relaxed text-muted-foreground mt-3">{section.content}</p>
              </details>
            ))}
          </div>

          <div className="mt-7 flex gap-8 text-xs text-muted-foreground">
            <span className="flex items-center gap-2">
              <Truck size={16} /> Shipping quoted at checkout
            </span>
            <span className="flex items-center gap-2">
              <RotateCcw size={16} /> 14-day returns
            </span>
          </div>
        </div>
      </div>

      {related.length > 0 && (
        <section className="site-container pt-24">
          <h2 className="font-display text-4xl mb-8">You may also like</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-5">
            {related.map((item) => (
              <ProductCard key={item.slug} product={item} />
            ))}
          </div>
        </section>
      )}
    </StoreLayout>
  );
}
