# The handoff, against what is built

The planning document lists sections 6–11. This records where each item lives and
which suite proves it, so a claim in a status report can be checked rather than
taken on trust.

## 6. Payments

| Item | State |
|---|---|
| Reputable provider, provider logic abstracted | Paystack. `src/lib/paystack.ts` is the only file that knows the provider; `mailer.ts` follows the same shape for email. |
| Naira checkout at launch | NGN throughout. Money is integer **kobo** everywhere; `formatMoney` is the only place a decimal appears. |
| International card/USD later | `currency` is a column, not a constant, so a second currency is data rather than a refactor. |
| Webhook confirmation and idempotent handling | `/api/webhooks/paystack`, signature-verified, replay-detected, idempotent. `e2e-refund-webhook.mjs`, `e2e-settlement.mjs`. |
| Never store raw card details | No card field exists anywhere in the schema, and the card is entered on Paystack's page. |

## 7. Admin

| Item | State |
|---|---|
| Create/edit/archive products | `e2e-admin-catalog.mjs` — through the real form, verified on the storefront. |
| Variants, images, prices, collections | Same suite; variants have their own editor. |
| Search/filter orders | Orders list with search and status filter. |
| Update fulfilment/tracking | Shipment form; `e2e-refund-admin.mjs` proves the notice carries carrier and tracking. |
| Refund/return handling | `e2e-refund-admin.mjs`, `e2e-refund-webhook.mjs`. |
| Inventory and low-stock alerts | `admin-metrics.ts` counts variants at or below 3; `inventory_movements` is the ledger, checked by `reconcile-stock.mjs`. |
| Dashboard: revenue, orders, AOV, top products | `getDashboard`. |

## 8. SEO and policy

| Item | State |
|---|---|
| Unique product/collection metadata | `storeSeo` emits title, description, canonical and Open Graph per page. |
| Canonical URLs and product structured data | One `@graph` per page with Organization, WebSite, Product and BreadcrumbList. |
| Optimised images and alt text | `image_alt` per product; the graph and Open Graph both use it. |
| **Useful redirects/archive pages for discontinued products** | An archived product RENDERS as an archive page — `noindex, follow`, canonical kept, **no offer**, with a route back to what is available. A **draft** stays a 404, because it is unfinished. `e2e-seo.mjs`. |
| Privacy, terms, shipping, returns/refunds | `/privacy`, `/terms`, `/shipping-returns`, `/refunds`, each rendered and linked in the footer. |

## 9. Security

| Item | State |
|---|---|
| Server-side admin authorisation | `requireCapability` in every admin server function; the shell gates on staff. `e2e-roles.mjs` proves a customer is refused and that a revoked role stops working **immediately**. |
| Protect customer/order data | Order lookup authorises in the service, not the page. |
| Rate-limit account/checkout endpoints | D1-backed fixed window; two keys on the contact form because an IP is shared. |
| Verify payment webhooks | HMAC-SHA512 over the exact bytes; unsigned and wrongly-signed refused with 401; replays recognised. |
| Audit price, inventory, refunds, order-state changes | `audit_log`; failures are audited too. |

## 10. Acceptance criteria

| Criterion | Proof |
|---|---|
| Search/browse works | `e2e.mjs` |
| Variant price/availability is correct | `e2e.mjs`, `e2e-seo.mjs` (offers from live variants) |
| Cart totals are correct | `e2e.mjs`; the arithmetic itself in `pnpm test` (`money.test.ts`) |
| Checkout validates data | `e2e.mjs` (incomplete address refused), `e2e-checkout.mjs` |
| Payment is server-confirmed | `e2e-settlement.mjs` — settled only via `confirmOrderPayment`, amount compared to the order |
| Order confirmation is generated | `e2e-settlement.mjs` — queued with items, total, address and reference |
| Admin can fulfil/update orders | `e2e-account.mjs`, `e2e-refund-admin.mjs` |
| Customer can view status | `/account` and `/order-lookup` |
| Out-of-stock cannot be purchased accidentally | `e2e.mjs` (sold-out variant unselectable) and `e2e-oversell.mjs` (the reservation is verified inside its own transaction) |
| Mobile checkout works | `e2e.mjs`, at 390px |
| Product pages are crawlable/shareable | `e2e-seo.mjs` — 75 checks |

## 11. Deferred, and not built

Third-party seller marketplace; complex loyalty or points; subscriptions; live
shopping; affiliate marketplace; native shopping app; multi-warehouse
international inventory; advanced personalisation. **None of these exist**, which
is the intended state.

## The honest gap

**The outbox cannot deliver.** Order confirmations, dispatch notices, refund
notices and contact acknowledgements are all written down, and all of them wait,
because no email provider is configured. `docs/EMAIL.md` gives the one command
that starts delivery. Until then nothing is lost and nothing is sent.

**No real card payment has been taken.** Everything downstream of settlement is
verified against production using a pre-settled payment fixture, which exercises
the same code without a gateway call. What is unverified is Paystack itself
returning into that path — a one-minute action with a real card.
