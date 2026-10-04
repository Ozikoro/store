import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { StoreLayout } from './layout';
import { Button } from '@/components/ui/button';
import { BrandMark } from './brand';

/**
 * The page a visitor gets when a product, collection or order does not exist.
 *
 * The default is the bare word "Not Found", which is a dead end: it tells the
 * visitor nothing about where they are or what to do. This one keeps the
 * header, the footer and the way back.
 *
 * It deliberately does NOT say whether the thing exists but is private. For an
 * order, "not found" and "not yours" are the same answer, because confirming
 * that a sequential order number exists is itself a leak.
 */
export function NotFound({
  title = 'We could not find that page.',
  detail = 'The link may be old, or the piece may have sold and been retired.',
}: {
  title?: string;
  detail?: string;
}) {
  return (
    <StoreLayout>
      <section className="site-container py-24 max-w-2xl">
        <BrandMark width={64} />
        <h1 className="font-display text-5xl md:text-6xl leading-[1.05] mt-8" data-testid="not-found-title">
          {title}
        </h1>
        <p className="text-muted-foreground mt-5 leading-relaxed">{detail}</p>

        <div className="flex flex-wrap gap-4 mt-9">
          <Button asChild>
            <Link to="/shop">Browse the store</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/">
              <ArrowLeft size={15} /> Back to the start
            </Link>
          </Button>
        </div>

        <div className="border-t border-border mt-12 pt-8">
          <p className="eyebrow mb-4">Looking for something specific?</p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Try the <Link to="/search" search={{ q: '' }} className="underline">search</Link>, or look through the{' '}
            <Link to="/collections" className="underline">collections</Link>. If you are trying to find an order,
            sign in and it will be on your <Link to="/account" className="underline">account page</Link>.
          </p>
        </div>
      </section>
    </StoreLayout>
  );
}
