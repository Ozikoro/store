import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { getCollections } from '@/server/catalog';

export const Route = createFileRoute('/collections/')({
  staticData: {
    seo: {
      title: 'Collections',
      description: 'Explore the Ozikoro Store collections: apparel, books and publications, prints, and artefacts.',
      kind: 'collection',
    },
  },
  loader: () => getCollections(),
  component: Collections,
});

function Collections() {
  const collections = Route.useLoaderData();

  return (
    <StoreLayout>
      <PageIntro
        eyebrow="Explore"
        title="The collections"
        description="A closer look at the things we make, publish and share."
      />
      <div className="site-container grid sm:grid-cols-2 lg:grid-cols-4 gap-6 pb-10">
        {collections.map((collection) => (
          <Link
            key={collection.slug}
            to="/collections/$slug"
            params={{ slug: collection.slug }}
            className="group"
            data-testid={`collection-${collection.slug}`}
          >
            <div className="aspect-[4/5] overflow-hidden bg-secondary">
              <img
                src={collection.image}
                alt={collection.title}
                width={912}
                height={1104}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              />
            </div>
            <div className="flex justify-between items-start mt-5">
              <div>
                <h2 className="font-display text-3xl">{collection.title}</h2>
                <p className="text-muted-foreground text-sm mt-1">{collection.description}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {collection.productCount} {collection.productCount === 1 ? 'piece' : 'pieces'}
                </p>
              </div>
              <ArrowUpRight size={20} />
            </div>
          </Link>
        ))}
      </div>
    </StoreLayout>
  );
}
