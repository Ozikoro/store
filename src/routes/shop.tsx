import { createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { ProductCard } from '@/store/product-card';
import { storeHead } from '@/store/head';
import { Button } from '@/components/ui/button';
import { getShop } from '@/server/catalog';

export const Route = createFileRoute('/shop')({
  loader: () => getShop(),
  head: () =>
    storeHead({
      title: 'Shop all',
      description:
        'Browse every piece in the Ozikoro Store: apparel, books and publications, prints and hand-carved artefacts.',
      path: '/shop',
    }),
  component: Shop,
});

type Sort = 'featured' | 'low' | 'high' | 'name';

function Shop() {
  const { products, categories } = Route.useLoaderData();
  const [filter, setFilter] = useState('All');
  const [sort, setSort] = useState<Sort>('featured');

  const shown = useMemo(() => {
    const filtered = filter === 'All' ? [...products] : products.filter((product) => product.category === filter);
    switch (sort) {
      case 'low':
        return filtered.sort((a, b) => priceOf(a) - priceOf(b));
      case 'high':
        return filtered.sort((a, b) => priceOf(b) - priceOf(a));
      case 'name':
        return filtered.sort((a, b) => a.title.localeCompare(b.title));
      default:
        return filtered;
    }
  }, [products, filter, sort]);

  return (
    <StoreLayout>
      <PageIntro
        eyebrow="The Ozikoro Store"
        title="Shop all"
        description="Considered pieces for curious minds and everyday life."
      />
      <div className="site-container">
        <div className="border-y border-border py-4 flex flex-wrap justify-between gap-4 items-center">
          <div className="flex gap-1 overflow-x-auto" role="group" aria-label="Filter by collection">
            {['All', ...categories].map((value) => (
              <Button
                key={value}
                variant={filter === value ? 'filterActive' : 'filter'}
                onClick={() => setFilter(value)}
                data-testid={`filter-${value.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              >
                {value}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground" data-testid="result-count">
              {shown.length} {shown.length === 1 ? 'product' : 'products'}
            </span>
            <label className="sr-only" htmlFor="sort">
              Sort products
            </label>
            <select
              id="sort"
              className="bg-background border-0 outline-none font-medium"
              value={sort}
              onChange={(event) => setSort(event.target.value as Sort)}
              data-testid="sort-select"
            >
              <option value="featured">Featured</option>
              <option value="low">Price: low to high</option>
              <option value="high">Price: high to low</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>

        {shown.length > 0 ? (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-12 md:gap-x-6 py-10">
            {shown.map((product) => (
              <ProductCard key={product.slug} product={product} />
            ))}
          </div>
        ) : (
          <p className="py-24 text-muted-foreground">Nothing in this collection yet.</p>
        )}
      </div>
    </StoreLayout>
  );
}

function priceOf(product: { price_minor: number; variants: Array<{ price_minor: number; is_active: number }> }): number {
  const active = product.variants.filter((variant) => variant.is_active).map((variant) => variant.price_minor);
  return active.length ? Math.min(...active) : product.price_minor;
}
