<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting published git history.
<!-- LOVABLE:END -->

- Keep the store as a standalone TanStack Start shopping experience with shared layout, product catalog, and cart modules; this keeps its commerce presentation distinct from the wider Ozikoro ecosystem.

- **The store IS transactional. Do not treat it as a preview.** The bullet that
  used to say "keep the catalog and checkout as an explicitly non-transactional
  preview until a commerce backend and verified inventory/payment workflow are
  connected" described the condition it was waiting for, and that condition has
  been met. All of the following are live:

  - **Cloudflare D1** for the catalogue, inventory, carts, orders, payments,
    refunds, shipments, discounts, sessions, the audit log and the OIDC tables.
    Migrations are `migrations/*.sql`, applied by `scripts/d1-migrate.mjs`.
  - **Paystack** for card payment, with the amount verified server-side against
    the order before anything settles. Settling happens through exactly one
    function, `confirmOrderPayment` — never by an operator, and
    `advanceOrderStatus` refuses to move an order to `paid` by hand.
  - **Real stock.** A variant's stock is reserved when an order is created and
    returned when it is cancelled or refunded, with an `inventory_movements` row
    for every change.
  - **Real products.** 9 products and 17 variants are seeded by
    `migrations/0002_seed_catalog.sql`; they are not invented placeholders.

  A change that makes checkout non-transactional, or that reintroduces
  placeholder stock or prices, is therefore a regression rather than caution.

- A new product is created as a **draft**. It is not on the storefront until its
  status is set to `active` — this is deliberate, so a half-written product is
  never in the shop. `product-category` is a required **free-text** field.

- The store is also the **identity provider** for the Ozikoro platforms. Identity
  is centralised, not mirrored: `ozikoro.com` and `ozituma.com` are OIDC clients.
  See `docs/SSO.md` before changing anything under `src/lib/oidc-*`,
  `src/server/oidc.ts`, or `routes/oidc/`.

- **A parent route that renders a component without an `<Outlet />` swallows its
  children.** The child's loader still runs, so the page keeps the right
  `<title>`, and the child's component never mounts — the URL changes and the page
  does not. This has already broken `/checkout/callback`, `/admin/orders/$number`
  and `/admin/products/$slug`. When a route gains a child, either give the parent
  an `<Outlet />` or move its UI to `index.tsx` in a folder, as `checkout/`,
  `admin/orders/` and `admin/products/` do.

- Verify against the deployed store after changing routes: `scripts/e2e-seo.mjs`,
  `scripts/e2e-admin-catalog.mjs`, `scripts/e2e-account.mjs`,
  `scripts/e2e-checkout.mjs`, `scripts/e2e-oidc.mjs`. Run `pnpm test` for the pure
  logic — the money rules and the order state machine.
