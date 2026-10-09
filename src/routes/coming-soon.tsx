import { createFileRoute, Link } from '@tanstack/react-router';

import { BrandMark } from '@/store/brand';
import { useShellAccount } from '@/store/shell-account';
import { storefrontIsOpen } from '@/lib/storefront';

/**
 * The page a closed storefront shows the public.
 *
 * WHY IT IS NOT PART OF THE STORE LAYOUT
 *
 * `StoreLayout` carries the header with cart, search and account, and the footer
 * with the policy links. Those are promises: they say "there is a shop here,
 * browse it". Rendering them on a coming-soon page offers a search box that
 * searches a catalogue nobody may see, and a cart nobody can fill. A closed shop
 * should not advertise doors.
 *
 * So this page is deliberately its own, minimal thing: the mark, the promise, and
 * one way to reach a human.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not collect an email address. An email form here would need somewhere
 * to put the addresses, a way to send to them, and a privacy answer for holding
 * them — and none of that exists yet. A "notify me" box that silently discards
 * what it is given is worse than no box. When delivery exists, this page can grow
 * one.
 *
 * A STAFF SESSION SEES THE WAY IN. The gate lets the owner through to `/admin`
 * while the shop is closed, and this page offers that link only to somebody who
 * already holds a staff session — so an ordinary visitor is not shown a door
 * marked "staff only", which invites exactly the wrong kind of curiosity.
 */
export const Route = createFileRoute('/coming-soon')({
  /**
   * If the shop has been opened, this page has nothing to say. Somebody arriving
   * from a stale bookmark should land in the shop rather than on a page telling
   * them it is coming — so it sends them on.
   *
   * Read here rather than in the root loader so the page is self-contained: the
   * root already has enough reasons to exist.
   */
  loader: async () => ({ open: await storefrontIsOpen() }),

  // Kept out of the index while it is the only public page, and out of the way
  // once the shop is open. `follow` stays on because the one link out — to
  // ozikoro.com — is a good one.
  head: () => ({
    meta: [
      { title: 'Ozikoro Store — coming soon' },
      {
        name: 'description',
        content:
          'The Ozikoro Store is being prepared. Thoughtfully made apparel, books, prints and artefacts from Ozikoro.',
      },
      { name: 'robots', content: 'noindex, follow' },
    ],
  }),

  component: ComingSoon,
});

function ComingSoon() {
  return (
    <div className="min-h-screen bg-ink text-ink-foreground">
      <div className="site-container flex min-h-screen max-w-3xl flex-col justify-center py-20">
        <BrandMark className="h-10 w-auto text-primary" color="currentColor" width={48} />

        <p className="eyebrow mt-14 text-primary">Ozikoro Store</p>
        <h1 className="font-display text-5xl leading-[1.05] mt-4 md:text-6xl">
          Something is being made.
        </h1>

        <p className="text-ink-foreground/70 mt-8 max-w-xl text-lg leading-relaxed">
          The Ozikoro Store is being prepared — apparel, books, prints and
          artefacts, made thoughtfully and shipped from Lagos. It is not open
          yet, but it will be.
        </p>

        <div className="mt-12 flex flex-wrap items-center gap-6 text-sm">
          <a
            href="https://ozikoro.com"
            className="inline-flex items-center gap-2 border-b border-primary/60 pb-1 text-primary transition-colors hover:border-primary"
          >
            Visit ozikoro.com
          </a>
          <a
            href="mailto:hello@ozikoro.com"
            className="text-ink-foreground/60 transition-colors hover:text-ink-foreground"
          >
            hello@ozikoro.com
          </a>
        </div>

        <StaffWayIn />
      </div>
    </div>
  );
}

/**
 * The link into the admin, shown ONLY to somebody who already has a staff
 * session.
 *
 * The session is read from the shell context, which the root loader has already
 * resolved — so this costs no request of its own, and the default it falls back
 * to is `isStaff: false`. The failure direction is the one that matters: if the
 * session is unknown, the link stays hidden.
 */
function StaffWayIn() {
  const staff = useShellAccount().isStaff;
  if (!staff) return null;

  return (
    <p className="mt-16 border-t border-white/10 pt-6 text-xs text-ink-foreground/50">
      You are signed in as staff.{' '}
      <Link to="/admin" className="underline transition-colors hover:text-ink-foreground">
        Open the admin
      </Link>{' '}
      to make changes, or to open the shop.
    </p>
  );
}
