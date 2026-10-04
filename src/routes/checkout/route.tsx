import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * The checkout layout.
 *
 * IT EXISTS FOR ONE REASON, AND IT WAS A BUG THAT MADE IT NECESSARY.
 *
 * This route was a single file, `checkout.tsx`, which rendered the checkout form
 * as its own component. `/checkout/callback` was therefore its CHILD, and a
 * parent route that renders a component WITHOUT an `<Outlet />` swallows that
 * child: the callback's loader ran — so the page had the right title and
 * description — while its component never mounted.
 *
 * The customer coming back from Paystack was shown the checkout form again, with
 * an empty cart, instead of their order confirmation. Nothing errored, no test
 * failed, and the page looked plausible, which is what makes it worth a whole
 * file to prevent.
 *
 * The form now lives in `checkout/index.tsx` and this renders the `<Outlet />`.
 */
export const Route = createFileRoute('/checkout')({
  component: () => <Outlet />,
});
