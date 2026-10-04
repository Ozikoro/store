/**
 * Store layout: announcement bar, header, footer.
 *
 * The header carries the official Ozikoro mark plus a typeset wordmark rather
 * than a raster logo, so it stays sharp at every size and re-colours with the
 * theme. The cart badge reads from the cart context, which is fed by the server
 * — never by a number in localStorage.
 */

import { Link, useLocation } from '@tanstack/react-router';
import { Search, ShoppingBag, UserRound, Menu, ArrowUpRight, X, ShieldCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { BrandLockup } from './brand';
import { useCart } from './cart';
import { useShellAccount } from './shell-account';

const NAV = [
  { label: 'Shop', to: '/shop' },
  { label: 'Collections', to: '/collections' },
  { label: 'Apparel', to: '/collections/$slug', slug: 'apparel' },
  { label: 'Books & Publications', to: '/collections/$slug', slug: 'books-publications' },
  { label: 'Prints', to: '/collections/$slug', slug: 'prints-posters' },
  { label: 'Art & Artefacts', to: '/collections/$slug', slug: 'art-artefacts' },
  { label: 'About', to: '/about' },
  { label: 'Contact', to: '/contact' },
] as const;

export interface StoreLayoutProps {
  children: ReactNode;
  /** Checkout and the payment callback drop the navigation. */
  minimal?: boolean;
  /** Set on the admin surface. */
  isStaff?: boolean;
}

export function StoreLayout({ children, minimal = false, isStaff }: StoreLayoutProps) {
  const { cart } = useCart();
  // The session is resolved on the server; this reads that result. It is a UI
  // convenience only — every admin function checks the capability itself.
  const account = useShellAccount();
  const showAdmin = isStaff ?? account.isStaff;
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {!minimal && (
        <div className="bg-ink text-ink-foreground text-center py-2 text-[11px] font-medium tracking-wide">
          Objects for a culture in motion. Thoughtfully made, meaningfully kept.
        </div>
      )}
      <header className="border-b border-border bg-background relative z-20">
        <div className="site-container flex h-[76px] items-center justify-between gap-4">
          {!minimal && (
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              data-testid="menu-toggle"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? <X /> : <Menu />}
            </Button>
          )}

          <Link to="/" aria-label="Ozikoro Store home" data-testid="brand-home">
            <BrandLockup markWidth={56} subtitle="The store" />
          </Link>

          {!minimal && (
            <nav className="hidden lg:flex items-center gap-6 xl:gap-8 text-[12px] font-medium" aria-label="Main">
              <Link to="/shop" className={location.pathname === '/shop' ? 'text-primary-strong' : 'hover:text-primary-strong'}>
                Shop
              </Link>
              <Link to="/collections" className="hover:text-primary-strong">
                Collections
              </Link>
              <Link to="/collections/$slug" params={{ slug: 'books-publications' }} className="hover:text-primary-strong">
                Books
              </Link>
              <Link to="/collections/$slug" params={{ slug: 'apparel' }} className="hover:text-primary-strong">
                Apparel
              </Link>
              <Link to="/collections/$slug" params={{ slug: 'prints-posters' }} className="hover:text-primary-strong">
                Prints
              </Link>
              <Link to="/collections/$slug" params={{ slug: 'art-artefacts' }} className="hover:text-primary-strong">
                Art &amp; Artefacts
              </Link>
              <Link to="/about" className="hover:text-primary-strong">
                About
              </Link>
            </nav>
          )}

          <div className="flex items-center gap-1 sm:gap-2">
            <Button variant="ghost" size="icon" asChild title="Search">
              <Link to="/search" search={{ q: '' }} aria-label="Search" data-testid="nav-search">
                <Search />
              </Link>
            </Button>
            {!minimal && (
              <Button variant="ghost" size="icon" asChild title="Account">
                <Link to="/account" aria-label="Account" data-testid="nav-account">
                  <UserRound />
                </Link>
              </Button>
            )}
            {showAdmin && (
              <Button variant="ghost" size="icon" asChild title="Admin">
                <Link to="/admin" aria-label="Admin" data-testid="nav-admin">
                  <ShieldCheck />
                </Link>
              </Button>
            )}
            <Button variant="ghost" size="icon" asChild title="Cart">
              <Link
                to="/cart"
                aria-label={`Cart, ${cart.count} ${cart.count === 1 ? 'item' : 'items'}`}
                className="relative"
                data-testid="nav-cart"
              >
                <ShoppingBag />
                {cart.count > 0 && (
                  <span
                    className="absolute -top-1 -right-1 bg-primary text-primary-foreground rounded-full text-[10px] h-4 min-w-4 flex items-center justify-center font-semibold"
                    data-testid="cart-count"
                  >
                    {cart.count}
                  </span>
                )}
              </Link>
            </Button>
          </div>
        </div>

        {menuOpen && !minimal && (
          <nav className="lg:hidden border-t border-border bg-background px-6 py-4 flex flex-col gap-4 text-sm" aria-label="Mobile">
            {NAV.map((item) =>
              'slug' in item ? (
                <Link
                  key={item.label}
                  to="/collections/$slug"
                  params={{ slug: item.slug }}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ) : (
                <Link key={item.label} to={item.to} onClick={() => setMenuOpen(false)}>
                  {item.label}
                </Link>
              )
            )}
          </nav>
        )}
      </header>

      <main>{children}</main>

      {!minimal && (
        <footer className="bg-ink text-ink-foreground mt-20">
          <div className="site-container py-16 grid gap-12 md:grid-cols-[2fr_1fr_1fr_1fr]">
            <div>
              <BrandLockup tone="cream" subtitle={null} wordmarkClassName="text-4xl" markWidth={64} />
              <p className="text-sm text-ink-muted max-w-xs leading-relaxed mt-5">
                Culture is not a thing of the past. It is something we carry forward.
              </p>
            </div>
            <div>
              <p className="footer-heading">Explore</p>
              <Link to="/shop">Shop all</Link>
              <Link to="/collections">Collections</Link>
              <Link to="/about">Our story</Link>
            </div>
            <div>
              <p className="footer-heading">Help</p>
              <Link to="/shipping-returns">Shipping &amp; returns</Link>
              <Link to="/account">Order history</Link>
              <Link to="/contact">Contact</Link>
            </div>
            <div>
              <p className="footer-heading">Policies</p>
              <Link to="/privacy">Privacy</Link>
              <Link to="/terms">Terms</Link>
              <Link to="/refunds">Refunds</Link>
            </div>
          </div>
          <div className="site-container border-t border-ink-line py-5 text-xs text-ink-muted flex flex-wrap justify-between gap-2">
            <span>© {new Date().getFullYear()} Ozikoro. All rights reserved.</span>
            <a href="https://ozikoro.com" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">
              ozikoro.com <ArrowUpRight size={12} />
            </a>
          </div>
        </footer>
      )}
    </div>
  );
}

export function PageIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string | undefined;
  title: string;
  description?: string | undefined;
}) {
  return (
    <section className="site-container pt-12 pb-9 md:pt-16 md:pb-12">
      {eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}
      <h1 className="font-display text-4xl md:text-6xl leading-[1.08] max-w-3xl">{title}</h1>
      {description && <p className="text-muted-foreground max-w-xl mt-5 leading-relaxed">{description}</p>}
    </section>
  );
}

/** A one-line notice, used for stock refusals and server errors. */
export function Notice({ tone = 'error', children }: { tone?: 'error' | 'info' | 'success'; children: ReactNode }) {
  const classes =
    tone === 'error'
      ? 'border-destructive/40 bg-destructive/5 text-destructive'
      : tone === 'success'
        ? 'border-primary-strong/40 bg-primary/10 text-foreground'
        : 'border-border bg-secondary text-foreground';
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`border px-4 py-3 text-sm ${classes}`}>
      {children}
    </p>
  );
}
