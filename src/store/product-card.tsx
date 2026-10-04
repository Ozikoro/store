import { Link } from '@tanstack/react-router';
import { formatMoney } from '@/lib/money';
import { isSoldOut, type ProductWithVariants } from '@/lib/catalog';

/**
 * A product as it appears in a grid.
 *
 * The price shown is the cheapest active variant, and it is clearly a "from"
 * price when the variants differ — a store that shows ₦110,000 on the card and
 * ₦160,000 on the page is a store the customer stops trusting.
 */
export function ProductCard({ product }: { product: ProductWithVariants }) {
  const active = product.variants.filter((variant) => variant.is_active);
  const prices = active.map((variant) => variant.price_minor);
  const cheapest = prices.length ? Math.min(...prices) : product.price_minor;
  const dearest = prices.length ? Math.max(...prices) : product.price_minor;
  const from = dearest > cheapest;
  const soldOut = isSoldOut(product);

  return (
    <Link
      to="/products/$slug"
      params={{ slug: product.slug }}
      className="group block min-w-0"
      data-testid={`product-card-${product.slug}`}
    >
      <div className="aspect-[4/5] overflow-hidden bg-secondary relative">
        <img
          src={product.image_url || '/media/print.jpg'}
          alt={product.image_alt || product.title}
          loading="lazy"
          width={912}
          height={1104}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.035]"
        />
        {soldOut && (
          <span className="absolute top-3 left-3 bg-ink text-ink-foreground text-[10px] uppercase tracking-[0.15em] px-2.5 py-1.5 font-semibold">
            Sold out
          </span>
        )}
        {!soldOut && product.made_to_order === 1 && (
          <span className="absolute top-3 left-3 bg-background/95 text-foreground text-[10px] uppercase tracking-[0.15em] px-2.5 py-1.5 font-semibold">
            Made to order
          </span>
        )}
      </div>
      <div className="pt-4">
        <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground mb-1.5">{product.category}</p>
        <div className="flex justify-between gap-4 items-start">
          <h3 className="font-display text-lg md:text-xl leading-tight group-hover:text-primary-strong">
            {product.title}
          </h3>
          <span className="text-sm whitespace-nowrap mt-1">
            {from ? `from ${formatMoney(cheapest, product.currency)}` : formatMoney(cheapest, product.currency)}
          </span>
        </div>
      </div>
    </Link>
  );
}
