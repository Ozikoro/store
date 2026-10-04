import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, createRootRouteWithContext, HeadContent, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import appCss from '../styles.css?url';
import { CartProvider } from '@/store/cart';
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
 head: () => ({ meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }], links: [{ rel: 'stylesheet', href: appCss }, { rel: 'preconnect', href: 'https://fonts.googleapis.com' }, { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' }, { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&display=swap' }] }),
 shellComponent: ({ children }: { children: ReactNode }) => <html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>,
 component: () => { const { queryClient } = Route.useRouteContext(); return <QueryClientProvider client={queryClient}><CartProvider><Outlet /></CartProvider></QueryClientProvider>; },
});
