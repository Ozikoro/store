import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, createRootRouteWithContext, HeadContent, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import appCss from '../styles.css?url';
import { CartProvider, type CartSnapshot } from '@/store/cart';
import { getCart, getAdminSession } from '@/server/store';
import { STORE_ORIGIN } from '@/store/head';
import { NotFound } from '@/store/not-found';

/**
 * The root route.
 *
 * The cart and the staff flag are loaded on the SERVER and passed into the
 * providers, so the header renders the right badge and the right links in the
 * first paint. Fetching them on the client instead would flash an empty cart
 * and a missing admin link on every navigation.
 *
 * A failure to load them must not take the storefront down: a database blip
 * should cost a wrong badge, not a blank page. Hence the catch.
 */
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: async () => {
    try {
      const [cart, admin] = await Promise.all([getCart(), getAdminSession()]);
      return { cart: cart as unknown as CartSnapshot, admin };
    } catch (error) {
      console.error('[root] could not load the cart or session', error);
      return { cart: null, admin: { staff: false as const } };
    }
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#ddb02f' },
      { name: 'format-detection', content: 'telephone=no' },
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
    ],
    scripts: [
      {
        type: 'application/ld+json',
        children: JSON.stringify({
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'Ozikoro Store',
          url: STORE_ORIGIN,
        }),
      },
    ],
  }),
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
    const { cart } = Route.useLoaderData();
    return (
      <QueryClientProvider client={queryClient}>
        <CartProvider initialCart={cart ?? undefined}>
          <Outlet />
        </CartProvider>
      </QueryClientProvider>
    );
  },
});
