import { createFileRoute } from '@tanstack/react-router';
import { StoreLayout, PageIntro } from '@/store/layout';
import { ProductCard } from '@/store/product-card';
import { searchProducts } from '@/server/catalog';
import { SearchForm } from '@/store/search-form';

export const Route = createFileRoute('/search')({
  staticData: {
    seo: {
      title: 'Search',
      description: 'Find books, apparel, prints and artefacts in the Ozikoro Store.',
      kind: 'search',
    },
  },
  validateSearch: (search: Record<string, unknown>) => ({
    q: typeof search['q'] === 'string' ? search['q'] : '',
  }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) => searchProducts({ data: { query: deps.q } }),
  component: SearchPage,
});

function SearchPage() {
  const { query, results } = Route.useLoaderData();

  return (
    <StoreLayout>
      <PageIntro eyebrow="Find something meaningful" title="Search the store" />
      <div className="site-container">
        <SearchForm initialQuery={query} />
        <p className="text-xs text-muted-foreground mt-8" data-testid="search-count">
          {query ? `${results.length} results for “${query}”` : `${results.length} pieces in the store`}
        </p>
        {results.length > 0 ? (
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-12 md:gap-x-6 mt-8">
            {results.map((product) => (
              <ProductCard key={product.slug} product={product} />
            ))}
          </div>
        ) : (
          <p className="py-24 text-muted-foreground">
            No products found. Try another search, or browse the shop.
          </p>
        )}
      </div>
    </StoreLayout>
  );
}
