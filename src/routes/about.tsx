import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { storeHead } from '@/store/head';
import { BrandMark } from '@/store/brand';

export const Route = createFileRoute('/about')({
  head: () =>
    storeHead({
      title: 'About',
      description:
        'The ideas behind the Ozikoro Store — a shop for objects that hold meaning, rooted in knowledge, creativity and cultural memory.',
      path: '/about',
    }),
  component: About,
});

function About() {
  return (
    <StoreLayout>
      <PageIntro eyebrow="Our story" title="Made to carry stories forward." />
      <div className="site-container border-t border-border pt-12 grid md:grid-cols-[1fr_1fr] gap-10 md:gap-24">
        <p className="font-display text-4xl md:text-5xl leading-tight">
          A store rooted in knowledge, creativity and cultural memory.
        </p>
        <div className="space-y-5 text-muted-foreground leading-relaxed">
          <p>
            The Ozikoro Store is a space for objects that hold meaning. From books that open new perspectives to
            everyday pieces that celebrate identity, each collection is shaped by a belief in the power of culture
            to connect us.
          </p>
          <p>
            Every piece here is made to be used or kept, not merely displayed. Apparel is cut from substantial
            cotton. Prints are archival and shipped rolled. The carvings and bronzes are made to order by
            craftspeople, one at a time, and each arrives with its provenance recorded.
          </p>
          <p>
            The Store is a separate destination within the Ozikoro world. Explore the wider Ozikoro institution for
            learning and research.
          </p>
          <div className="flex flex-wrap gap-6 pt-5 text-sm text-foreground">
            <a
              href="https://ozikoro.com"
              target="_blank"
              rel="noreferrer"
              className="inline-flex gap-1 items-center underline"
            >
              Ozikoro <ArrowUpRight size={15} />
            </a>
          </div>
          <p className="pt-7 text-sm">
            Questions about the store?{' '}
            <Link to="/contact" className="underline text-foreground">
              Contact us
            </Link>
            .
          </p>
        </div>
      </div>

      <section className="site-container pt-20 pb-4">
        <div className="border border-border p-8 flex flex-col sm:flex-row items-start gap-6">
          <BrandMark width={72} />
          <div>
            <h2 className="font-display text-2xl">The mark</h2>
            <p className="text-muted-foreground text-sm mt-2 leading-relaxed max-w-2xl">
              The Ozikoro mark is a stylised òzò — the carved staff that marks authority and lineage in Igbo
              tradition — set in the brand's yellow, <span className="font-mono">#ddb02f</span>, against ink.
            </p>
          </div>
        </div>
      </section>
    </StoreLayout>
  );
}
