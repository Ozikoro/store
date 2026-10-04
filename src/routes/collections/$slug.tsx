import { createFileRoute, notFound } from '@tanstack/react-router';
import { StoreLayout, PageIntro } from '@/store/layout';
import { ProductCard } from '@/store/product-card';
import { NotFound } from '@/store/not-found';
import { composeRouteHead } from '@/store/head-compose';
import { getCollection } from '@/server/catalog';

export const Route = createFileRoute('/collections/$slug')({
  loader: async ({ params }) => {
    const result = await getCollection({ data: { slug: params.slug } });
    if (!result.found) throw notFound();
    return result;
  },
  // The collection's name and image exist only at request time, so this route
  // composes its own head. The canonical URL, the robots directive, the
  // verification tags and the Organization and WebSite nodes still come from the
  // shared composition — only the page's own values are supplied here.
  staticData: { ownsHead: true },
  head: (ctx) =>
    composeRouteHead({
      ctx,
      kind: 'collection',
      fallbackTitle: 'Collection',
      route: ctx.loaderData?.found
        ? {
            title: ctx.loaderData.collection.title,
            description:
              ctx.loaderData.collection.description ||
              `Shop the ${ctx.loaderData.collection.title} collection.`,
            image: ctx.loaderData.collection.image_url,
            imageAlt: ctx.loaderData.collection.title,
            trail: [
              { name: 'Shop', path: '/shop' },
              { name: ctx.loaderData.collection.title, path: `/collections/${ctx.loaderData.collection.slug}` },
            ],
          }
        : { title: 'Collection not found', noindex: true },
    }),
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
