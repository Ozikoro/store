import { createFileRoute, notFound } from '@tanstack/react-router';
import { StoreLayout, PageIntro } from '@/store/layout';
import { ProductCard } from '@/store/product-card';
import { NotFound } from '@/store/not-found';
import { storeHead, breadcrumbStructuredData } from '@/store/head';
import { getCollection } from '@/server/catalog';

export const Route = createFileRoute('/collections/$slug')({
  loader: async ({ params }) => {
    const result = await getCollection({ data: { slug: params.slug } });
    if (!result.found) throw notFound();
    return result;
  },
  head: ({ loaderData }) => {
    if (!loaderData?.found) {
      return storeHead({ title: 'Collection not found', description: 'That collection does not exist.', path: '/collections' });
    }
    return storeHead({
      title: loaderData.collection.title,
      description: loaderData.collection.description || `Shop the ${loaderData.collection.title} collection.`,
      path: `/collections/${loaderData.collection.slug}`,
      image: loaderData.collection.image_url,
    });
  },
  component: Collection,
  notFoundComponent: () => (
    <NotFound
      title="We could not find that collection."
      detail="It may have been renamed. The current collections are all listed on the collections page."
    />
  ),
});

function Collection() {
  const { collection, products } = Route.useLoaderData();

  return (
    <StoreLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: breadcrumbStructuredData([
            { name: 'Shop', path: '/shop' },
            { name: collection.title, path: `/collections/${collection.slug}` },
          ]),
        }}
      />
      <PageIntro eyebrow="Collection" title={collection.title} description={collection.description} />

      {products.length > 0 ? (
        <div className="site-container border-t border-border pt-10 grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-12 md:gap-x-6">
          {products.map((product) => (
            <ProductCard key={product.slug} product={product} />
          ))}
        </div>
      ) : (
        <p className="site-container border-t border-border pt-10 text-muted-foreground">
          Nothing in this collection yet.
        </p>
      )}
    </StoreLayout>
  );
}
