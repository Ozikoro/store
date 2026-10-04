import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * The public product layout.
 *
 * It is a layout with no UI of its own, and it exists for a mechanical reason: a
 * nested route file such as `products/$slug.tsx` needs a parent to hang from, and
 * the generated route tree names that parent `/products`. Without a file
 * declaring it, the tree referenced a route that did not exist and the product
 * page answered 404 — with the build green and the type-check clean, because the
 * dangling name only exists inside the generated tree.
 *
 * The ADMIN product list has its own layout at `admin/products/route.tsx`; the
 * two are different route branches and neither may be moved into the other.
 */
export const Route = createFileRoute('/products')({
  component: () => <Outlet />,
});
