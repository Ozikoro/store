import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, createRootRouteWithContext, HeadContent, Scripts, redirect } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import appCss from '../styles.css?url';
import { CartProvider, type CartSnapshot } from '@/store/cart';
import { ShellAccountProvider } from '@/store/shell-account';
import { getCart, getAdminSession } from '@/server/store';
import { getSeoSettings } from '@/server/seo';
import { NotFound } from '@/store/not-found';
import {
  composeHead,
  currentPath,
  ownsHeadFromMatches,
  seoFromMatches,
  settingsFromMatches,
} from '@/store/head-compose';
import { FALLBACK_SETTINGS } from '@/lib/seo-settings';
import { COMING_SOON_PATH, isHiddenWhenClosed, storefrontIsOpen } from '@/lib/storefront';

/**
 * The root route.
 *
 * It loads four things, each for a reason:
 *
 *   the cart      server-rendered, so the header badge is right in the first
 *                 paint rather than flashing empty
 *   the session   so a staff account sees the admin link immediately
 *   the SEO       settings, including the search-engine verification codes, so
 *                 the head can emit them without a second read
 *   nothing else  everything else belongs to a page
 *
 * A failure to load any of them must not take the storefront down: a database
 * blip should cost a wrong badge or a missing verification tag, not a blank page.
 * Hence the catches — and for SEO, a full set of fallbacks that are correct
 * without the database at all.
 *
 * THE HEAD IS COMPOSED HERE, FOR EVERY PAGE. See `src/store/head-compose.ts` for
 * why that is not each route's job.
 *
 * THE STOREFRONT'S VISIBILITY IS ALSO DECIDED HERE, and this is the only place it
 * can be decided once. The switch is a single setting, but the storefront is forty
 * routes, so a check inside each page would be forty chances to forget one — and
 * the page that forgot would be the one a customer found first. The root sees
 * every navigation, so it enforces the switch for all of them, and the routes that
 * must stay reachable while the shop is closed are named in `src/lib/storefront.ts`
 * rather than remembered per page.
 */
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  /**
   * Close the door, before anything else runs.
   *
   * `beforeLoad` rather than a render-time branch, for two reasons. It happens
   * BEFORE the page's own loader, so a hidden page cannot do work or leak a title
   * on its way to being hidden. And it is a real redirect, so a visitor following
   * a stale link lands somewhere they can understand, at an address they can
   * share, rather than on a page that silently is not what they asked for.
   *
   * A redirect to the page already being requested would loop, so the closed-state
   * page is excluded — `isHiddenWhenClosed` excludes it along with the admin, the
   * payment webhook, and the identity provider, each for a reason recorded beside
   * the list.
   */
  beforeLoad: async ({ location }) => {
    const open = await storefrontIsOpen();
    if (open) return;
    if (!isHiddenWhenClosed(location.pathname)) return;

    /*
     * STAFF SEE THEIR OWN SHOP WHILE IT IS CLOSED.
     *
     * Without this, closing the shop locks out the only people who can open it
     * again — and makes it impossible to look at the thing you are preparing. A
     * closed shop is a closed DOOR, not a blindfold for the people inside it.
     *
     * The session is resolved here rather than reusing the loader's, because
     * `beforeLoad` runs before the loader and cannot wait for it. That is one
     * extra session read on a request that is about to be redirected anyway — the
     * cheapest place in the whole app to spend it.
     *
     * `getAdminSession` already catches its own failures and reports "not staff",
     * so a database blip fails toward hiding the shop, which is the safe
     * direction.
     */
    const session = await getAdminSession().catch(() => null);
    if (session?.staff === true) return;

    throw redirect({ to: COMING_SOON_PATH, replace: true });
  },

  loader: async () => {
    const [cart, admin, seo] = await Promise.all([
      getCart().catch((error: unknown) => {
        console.error('[root] could not load the cart', error);
        return null;
      }),
      getAdminSession().catch((error: unknown) => {
        console.error('[root] could not resolve the session', error);
        return { staff: false as const };
      }),
      getSeoSettings().catch((error: unknown) => {
        console.error('[root] could not load the SEO settings', error);
        return null;
      }),
    ]);

    return {
      cart: cart as unknown as CartSnapshot | null,
      admin,
      seo: seo ?? FALLBACK_SETTINGS,
    };
  },

  head: (ctx) => {
    const settings = settingsFromMatches(ctx.matches) ?? FALLBACK_SETTINGS;
    const route = seoFromMatches(ctx.matches);
    const ownsHead = ownsHeadFromMatches(ctx.matches);
    // The DEEPEST match, not `ctx.match`. `ctx.match` is the root here — it is
    // the match whose head is running — and reading the path from it gave every
    // page a canonical URL pointing at the home page.
    const path = currentPath(ctx);

    const composed = composeHead({
      path,
      settings,
      route,
      fallbackTitle: 'Ozikoro Store',
      fallbackDescription: settings.defaultDescription,
      kind: 'website',
    });

    return {
      meta: [
        { charSet: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'theme-color', content: '#ddb02f' },
        { name: 'format-detection', content: 'telephone=no' },
        ...composed.meta,
      ],
      links: [
        { rel: 'stylesheet', href: appCss },
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
        {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&display=swap',
        },
        ...composed.links.filter((link) =>
          // Two canonical URLs make a canonical ignored, and two graphs describe
          // two entities. A route that composes its own head emits both, so the
          // root drops exactly those two and keeps everything else.
          ownsHead ? link['rel'] !== 'canonical' : true
        ),
      ],
      scripts: ownsHead ? [] : composed.scripts,
    };
  },

  notFoundComponent: () => <NotFound />,
  shellComponent: ({ children }: { children: ReactNode }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ),
  component: () => {
    const { queryClient } = Route.useRouteContext();
    const { cart, admin } = Route.useLoaderData();
    return (
      <QueryClientProvider client={queryClient}>
        <ShellAccountProvider
          account={{
            isStaff: admin?.staff === true,
            name: admin?.staff === true ? admin.name : '',
            email: admin?.staff === true ? admin.email : '',
          }}
        >
          <CartProvider initialCart={cart ?? undefined}>
            <Outlet />
          </CartProvider>
        </ShellAccountProvider>
      </QueryClientProvider>
    );
  },
});
