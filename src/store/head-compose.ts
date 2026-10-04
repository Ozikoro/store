/**
 * Head composition, in one place.
 *
 * WHY THE ROOT OWNS THIS
 *
 * The store previously built its head in fourteen routes: each called
 * `storeHead(...)`, and two of them added a JSON-LD script of their own. That is
 * how it ended up with four unrelated `@graph`-less JSON-LD blocks and a sitemap
 * that listed `/admin`. A page's SEO is not a per-page concern — it is a
 * property of the site — so it is composed once, here, from three inputs:
 *
 *   the settings     what the owner set, including the verification codes
 *   the route        `staticData.seo` (or a route's own `head`, which merges)
 *   the render       the path, and anything the loader learned
 *
 * A new route therefore gets a correct title, canonical, robots directive,
 * Open Graph block, verification tags and structured-data graph **without
 * mentioning SEO at all**. Forgetting it is no longer possible, which matters
 * more than any single tag.
 *
 * WHAT A ROUTE DECLARES
 *
 *   export const Route = createFileRoute('/shop')({
 *     staticData: { seo: { title: 'Shop all', description: '…' } },
 *     …
 *   })
 *
 * Dynamic routes declare it through the route's own `head`, which receives
 * `loaderData` and merges a `noindex` where the data says so — a product that
 * does not exist is not a page to index.
 */

import type { SeoSettings } from '../lib/seo-settings';
import { storeSeo, type PageKind, type SeoInput } from './seo';

/**
 * What a route may declare about itself.
 *
 * Everything is optional: a route with nothing to say still gets the site's
 * identity, a canonical URL and a graph node, because the root fills the gaps.
 */
export interface RouteSeo {
  title?: string;
  description?: string;
  kind?: PageKind;
  image?: string | null;
  imageAlt?: string | null;
  published?: string | null;
  updated?: string | null;
  reference?: string | null;
  trail?: Array<{ name: string; path: string }>;
  topics?: string[];
  noindex?: boolean;
  offers?: SeoInput['offers'];
}

/** The `staticData` shape this app uses. Declared so a typo is a compile error. */
export interface RouteStaticData {
  seo?: RouteSeo;
  /**
   * This route composes its own head and emits its own canonical URL and graph.
   *
   * It exists for one situation: a page whose title, image or offers exist only
   * at request time, so the root cannot compose for it. The root then suppresses
   * exactly the tags the route will emit — `canonical` and the JSON-LD script —
   * and keeps everything else, because those two are the only ones TanStack does
   * not deduplicate. A page with two canonical URLs is a page whose canonical is
   * ignored, and two graphs are two entities.
   */
  ownsHead?: boolean;
}

/** The root loader's return, which is where the settings travel. */
export interface RootHeadData {
  seo?: SeoSettings;
}

/**
 * Compose a route's own head, for a page whose values exist only at request time.
 *
 * The root already composes a head for every page, and for a static route that
 * is all there is to it. A product page cannot work that way: its title, its
 * image and its offers come from the catalogue, which the root has not read.
 *
 * TanStack MERGES the head results down the matched branch and does NOT
 * deduplicate, so a route that returns a `title` produces two `<title>` elements
 * unless the root's is suppressed. `ctx.match.id` is exactly that switch: when a
 * child returns a head, the root's meta is dropped for that match.
 *
 * Everything not named here — the canonical URL, the robots directive, the
 * verification tags, the Organization and WebSite nodes, the breadcrumb — still
 * comes from the shared composition, so a dynamic route cannot get them wrong.
 */
export function composeRouteHead(input: {
  ctx: { matches: unknown; match: unknown };
  route: RouteSeo;
  kind: PageKind;
  fallbackTitle: string;
}) {
  const settings = settingsFromMatches(input.ctx.matches) ?? null;
  if (!settings) {
    // Without the settings the root will compose a complete head of its own, so
    // returning nothing here is the safe answer rather than emitting a partial
    // one that would suppress it.
    return {};
  }
  const path = currentPath(input.ctx);
  return composeHead({
    path,
    settings,
    route: input.route,
    fallbackTitle: input.fallbackTitle,
    fallbackDescription: input.route.description ?? settings.defaultDescription,
    kind: input.kind,
  });
}

/**
 * The deepest matched route's pathname.
 *
 * `ctx.match` is the match for the ROUTE WHOSE HEAD IS RUNNING — the root, in
 * every case here — so `ctx.match.pathname` is `/` on a product page. Using it
 * for the canonical URL made every page in the store declare itself a duplicate
 * of the home page, which is the single most damaging thing a canonical can say.
 *
 * The deepest entry of `ctx.matches` is the page actually being served, because
 * the matches array is the resolved branch from the root down. A trailing slash
 * is trimmed so `/shop/` and `/shop` cannot produce two canonical URLs.
 */
export function currentPath(ctx: { matches: unknown }): string {
  if (Array.isArray(ctx.matches) && ctx.matches.length) {
    const deepest = ctx.matches[ctx.matches.length - 1] as { pathname?: unknown } | undefined;
    const pathname = deepest?.pathname;
    if (typeof pathname === 'string' && pathname.length) {
      return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    }
  }
  return '/';
}

/**
 * Read the settings the root loader put on the match.
 *
 * The head runs before the component, so the loader it reads is the one already
 * resolved — no second database read, and no risk of the head and the page
 * disagreeing about which settings are in force.
 */
export function settingsFromMatches(matches: unknown): SeoSettings | null {
  if (!Array.isArray(matches)) return null;
  for (const match of matches) {
    if (!match || typeof match !== 'object') continue;
    const loaderData = (match as { loaderData?: unknown }).loaderData;
    if (loaderData && typeof loaderData === 'object' && 'seo' in (loaderData as object)) {
      const seo = (loaderData as RootHeadData).seo;
      if (seo) return seo;
    }
  }
  return null;
}

/**
 * The deepest `staticData.seo` on the matched branch.
 *
 * Deepest wins, so a child route refines its parent rather than the parent
 * overwriting the child — `/collections/apparel` is more specific than
 * `/collections`.
 */
/** Does the deepest matched route compose a head of its own? */
export function ownsHeadFromMatches(matches: unknown): boolean {
  if (!Array.isArray(matches)) return false;
  let owns = false;
  for (const match of matches) {
    if (!match || typeof match !== 'object') continue;
    const staticData = (match as { staticData?: unknown }).staticData;
    if (!staticData || typeof staticData !== 'object') continue;
    if ((staticData as RouteStaticData).ownsHead) owns = true;
  }
  return owns;
}

export function seoFromMatches(matches: unknown): RouteSeo | null {
  if (!Array.isArray(matches)) return null;
  let found: RouteSeo | null = null;
  for (const match of matches) {
    if (!match || typeof match !== 'object') continue;
    const staticData = (match as { staticData?: unknown }).staticData;
    if (!staticData || typeof staticData !== 'object') continue;
    const seo = (staticData as RouteStaticData).seo;
    if (seo) found = seo;
  }
  return found;
}

/**
 * Compose the whole head.
 *
 * `path` is passed in rather than derived from a URL because the head may run
 * where there is no request — during prerender or a client-side navigation — and
 * a canonical URL built from the wrong origin is worse than none.
 */
export function composeHead(input: {
  path: string;
  settings: SeoSettings;
  route: RouteSeo | null;
  fallbackTitle: string;
  fallbackDescription: string;
  kind?: PageKind;
}) {
  const route = input.route ?? {};
  const seo = storeSeo({
    title: route.title ?? input.fallbackTitle,
    description: route.description ?? input.fallbackDescription,
    path: input.path,
    kind: route.kind ?? input.kind ?? 'website',
    image: route.image ?? null,
    imageAlt: route.imageAlt ?? null,
    published: route.published ?? null,
    updated: route.updated ?? null,
    reference: route.reference ?? null,
    trail: route.trail ?? [],
    topics: route.topics ?? [],
    // Only pass this when the route actually says so. Passing `false` would
    // override the path rule in `storeSeo`, which is what decides that the cart,
    // the checkout, the account pages and the admin are not indexable — and an
    // explicit `false` from a route that simply had no opinion is how three of
    // those four ended up indexable.
    ...(route.noindex === undefined ? {} : { noindex: route.noindex }),
    settings: input.settings,
    offers: route.offers ?? null,
  });

  return {
    meta: seo.meta,
    links: seo.links,
    // One script, one graph: the site's identity and the page's, in a single
    // document. Several script tags leave a crawler to guess whether the
    // Organization on one page is the Organization on another.
    scripts: [{ type: 'application/ld+json', children: seo.jsonLd }],
  };
}
