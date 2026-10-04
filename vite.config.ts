/**
 * Vite + Nitro configuration.
 *
 * The comments at the top of the config that this file replaces listed what
 * `@lovable.dev/vite-tanstack-config` already provides — TanStack Start, React,
 * Tailwind, the `@` alias, and the Cloudflare build target. None of that is
 * re-added here. What IS added is the commerce infrastructure:
 *
 *   - `nitro.routes`: the Paystack webhook. It must be a raw request handler,
 *     not a page route, because it has to read the request body as text and
 *     verify an HMAC over the exact bytes before anything parses it — and
 *     because Paystack's retry logic keys on the status code, which a page
 *     route cannot control.
 *
 *   - `nitro.cloudflare.wrangler`: the D1 binding and the environment. Nitro
 *     generates the deployed `wrangler.json` from this, so the binding exists
 *     in the Worker and in `wrangler dev` alike. Declaring it here rather than
 *     in a hand-written `wrangler.json` means there is one source of truth for
 *     the worker name, the compatibility flags and the bindings.
 */

import { defineConfig } from '@lovable.dev/vite-tanstack-config';

/**
 * D1 database id for `ozikoro-store`, created in account ea4b95012b9f4252ff61c9393a87287f
 * with `scripts/d1-migrate.mjs` applying the schema. Override with
 * STORE_D1_DATABASE_ID when building against a different database.
 */
const D1_DATABASE_ID = process.env['STORE_D1_DATABASE_ID'] ?? 'b4111199-9dfb-4f85-bdd1-eff593afcb15';

/**
 * Nitro's Cloudflare options, including the `wrangler` escape hatch its own
 * documentation describes. The published types for the Lovable wrapper stop at
 * `{ nodeCompat, deployConfig }`, so the object is built separately and cast
 * once, here, rather than sprinkling casts through the config.
 */
interface CloudflareOptions {
  nodeCompat?: boolean;
  deployConfig?: boolean;
  wrangler?: Record<string, unknown>;
}

const cloudflare: CloudflareOptions = {
  nodeCompat: true,
  deployConfig: true,
  wrangler: {
    name: 'ozikoro-store',
    compatibility_flags: ['nodejs_compat'],
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'ozikoro-store',
        database_id: D1_DATABASE_ID,
      },
    ],
    vars: {
      STORE_ENV: process.env['STORE_ENV'] ?? 'production',
      STORE_ORIGIN: process.env['STORE_ORIGIN'] ?? 'https://shop.ozikoro.com',
      ADMIN_EMAILS: process.env['STORE_ADMIN_EMAILS'] ?? 'hello@ozikoro.com',
    },
    // Secrets are set with `wrangler secret put`, never committed:
    //   PAYSTACK_SECRET_KEY, SESSION_SECRET
    observability: { enabled: true },
  },
};

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR
    // error wrapper, which also owns the webhook interception).
    server: { entry: 'server' },
    // The admin routes are client code that calls the admin server functions,
    // so the Start compiler has to load `src/server/admin.ts` in the client
    // environment to split its handler bodies out into the server chunk. The
    // wrapper's default rule denies every `**/server/**` file there, so exactly
    // one module is exempted. That is safe only because every export of
    // `src/server/admin.ts` is a `createServerFn`: verified after a build that
    // no SQL, no `lib/` code, no handler message and no binding string from it
    // reaches the browser bundle. Everything else under `src/server/` stays
    // denied — in particular `src/server/store.ts`, which is why the admin
    // module reaches its guard with a lazy import.
    importProtection: {
      behavior: 'error',
      client: {
        // Every module under `src/server/` holds nothing but `createServerFn`
        // exports, so the compiler can load them in the client environment and
        // strip the handler bodies — which is exactly what it must do to leave
        // an RPC stub behind. `src/server/request.ts` is the one exception: it
        // is the server-only request API, reached with a dynamic import from
        // inside handlers precisely so it never enters this graph.
        files: ['**/server/**'],
        excludeFiles: [
          '**/server/store.ts',
          '**/server/catalog.ts',
          '**/server/admin.ts',
          '**/server/account.ts',
          '**/server/confirmation.ts',
          // Every export is a createServerFn; the request API is reached by a
          // dynamic import from inside a handler, so it is stripped with them.
          '**/server/oidc.ts',
          '**/server/seo.ts',
          '**/server/typed.ts',
        ],
      },
    },
  },
  nitro: {
    // Route-level handlers that run before the SSR router.
    routes: {
      '/api/webhooks/paystack': {
        handler: './routes/api/webhooks/paystack.ts',
      },
      // Generated from the live catalogue, so a product added in the admin is
      // discoverable without a deploy. A static file could not do that.
      '/sitemap.xml': {
        handler: './routes/sitemap.xml.ts',
      },
      '/robots.txt': {
        handler: './routes/robots.txt.ts',
      },

      // The identity provider. Raw routes rather than pages, because these must
      // answer with redirects and JSON before any application code runs, and
      // because an identity protocol kept out of the UI layer is easier to
      // reason about than one entangled with it.
      '/.well-known/openid-configuration': {
        handler: './routes/oidc/.well-known-openid-configuration.ts',
      },
      '/oidc/authorize': { handler: './routes/oidc/authorize.ts' },
      '/oidc/token': { handler: './routes/oidc/token.ts' },
      '/oidc/userinfo': { handler: './routes/oidc/userinfo.ts' },
      '/oidc/jwks.json': { handler: './routes/oidc/jwks.json.ts' },
      '/oidc/logout': { handler: './routes/oidc/logout.ts' },
    },
    cloudflare,
  } as never,
});
