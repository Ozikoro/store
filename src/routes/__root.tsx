import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, createRootRouteWithContext, HeadContent, Scripts } from '@tanstack/react-router';
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
 */
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
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
