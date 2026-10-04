import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * The product list layout.
 *
 * IT EXISTS SO THE DETAIL PAGE CAN RENDER. This was a single file,
 * `admin/products.tsx`, which rendered the list as its own component — and
 * `/admin/products/$...` was its CHILD. A parent route that renders a component
 * WITHOUT an `<Outlet />` swallows that child, so opening any record showed the
 * list again: the URL changed, the page did not.
 *
 * Nothing errored. The list is a plausible thing to see at that URL, which is
 * why it went unnoticed until the same fault was found on `/checkout/callback`.
 * The UI now lives in `index.tsx` and this renders the `<Outlet />`.
 */
export const Route = createFileRoute('/admin/products')({
  component: () => <Outlet />,
});
