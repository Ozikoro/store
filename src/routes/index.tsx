import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { StoreLayout } from '@/store/layout';
import { ProductCard } from '@/store/product-card';
import { storeHead, organisationStructuredData } from '@/store/head';
import { Button } from '@/components/ui/button';
import { getStorefront } from '@/server/catalog';

export const Route = createFileRoute('/')({
  loader: () => getStorefront(),
  head: () =>
    storeHead({
      title: 'Ozikoro Store — culture, made tangible',
      description:
        'Thoughtfully made apparel, books, prints and artefacts from Ozikoro. Naira checkout, shipping across Nigeria, made-to-order artwork.',
      path: '/',
    }),
  component: Home,
});

function Home() {
  const { featured, categories, collections, productCount } = Route.useLoaderData();

  return (
    <StoreLayout>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: organisationStructuredData() }} />

      <section className="relative min-h-[490px] md:min-h-[630px] flex items-center overflow-hidden bg-ink">
        <img
          src="/media/store-hero.jpg"
          width={1600}
          height={1008}
          alt="Ozikoro book, apparel and art print arranged together"
          className="absolute inset-0 h-full w-full object-cover object-[63%_center] opacity-70"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-ink/85 via-ink/45 to-transparent" />
        <div className="site-container relative py-24 text-ink-foreground">
          <p className="text-[11px] uppercase tracking-[0.2em] font-semibold mb-6">The Ozikoro Store</p>
          <h1 className="font-display text-[clamp(4rem,7vw,7.5rem)] leading-[0.88] max-w-[720px]">
            Culture, made
            <br />
            <em className="font-normal">tangible.</em>
          </h1>
          <p className="mt-8 text-base md:text-lg max-w-md leading-relaxed text-ink-foreground/90">
            Thoughtful objects inspired by the stories, ideas and heritage we carry forward.
          </p>
          <Button asChild variant="hero" size="lg" className="mt-9">
            <Link to="/shop" data-testid="hero-cta">
              Explore the store <ArrowRight />
            </Link>
          </Button>
        </div>
        <span className="absolute right-8 bottom-7 text-ink-foreground/80 text-[11px] uppercase tracking-widest hidden md:block">
          01 / A culture in motion
        </span>
      </section>

      {categories.length > 0 && (
        <section className="site-container py-18 md:py-24">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-9">
            <div>
              <p className="eyebrow mb-3">The collection</p>
              <h2 className="font-display text-4xl md:text-5xl">Objects with meaning.</h2>
            </div>
            <Link
              to="/collections"
              className="text-sm border-b border-foreground pb-1 inline-flex gap-2 items-center"
            >
              View all collections <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {categories.map((category) => (
              <Link
                key={category.slug}
                to="/collections/$slug"
                params={{ slug: category.slug }}
                className="group relative overflow-hidden aspect-[4/4.5] bg-secondary"
              >
                <img
                  src={category.image}
                  alt={category.title}
                  width={912}
                  height={1104}
                  loading="lazy"
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
                <div className="absolute inset-x-0 bottom-0 pt-20 pb-7 px-7 bg-gradient-to-t from-ink/80 to-transparent text-ink-foreground">
                  <h3 className="font-display text-3xl">{category.title}</h3>
                  <p className="text-sm mt-1 text-ink-foreground/80">{category.description}</p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {featured.length > 0 && (
        <section className="bg-secondary py-18 md:py-24">
          <div className="site-container">
            <div className="flex flex-wrap justify-between gap-4 items-end mb-9">
              <div>
                <p className="eyebrow mb-3">Selected for you</p>
                <h2 className="font-display text-4xl md:text-5xl">From the store</h2>
              </div>
              <Link to="/shop" className="text-sm border-b border-foreground pb-1 inline-flex gap-2 items-center">
                Shop all products <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-9 md:gap-x-6">
              {featured.map((product) => (
                <ProductCard key={product.slug} product={product} />
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="site-container py-20 md:py-28 grid md:grid-cols-2 gap-10 md:gap-28 items-center">
        <p className="font-display text-4xl md:text-6xl leading-[1.08]">
          More than things.
          <br />
          <em className="text-primary-strong">A way to remember.</em>
        </p>
        <div>
          <p className="eyebrow mb-5">The idea behind the store</p>
          <p className="leading-relaxed text-muted-foreground max-w-lg">
            Every piece is a small invitation to stay curious, to celebrate where we come from and to take our
            stories into what comes next.
          </p>
          <p className="leading-relaxed text-muted-foreground max-w-lg mt-4">
            {collections.length} collections, {productCount} pieces. Every order is confirmed by card payment and
            tracked to your door.
          </p>
          <Link to="/about" className="inline-flex items-center gap-2 mt-7 text-sm border-b border-foreground pb-1">
            About Ozikoro Store <ArrowUpRight size={16} />
          </Link>
        </div>
      </section>
    </StoreLayout>
  );
}
