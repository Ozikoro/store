/**
 * The store's canonical host, and the one alias it answers to.
 *
 * The handoff document names `store.ozikoro.com` as the commerce address; the
 * owner asked for `shop.ozikoro.com`. Both are live, and the document's address
 * redirects permanently to the owner's, so no link written from the
 * specification breaks and there is one canonical host for search engines,
 * canonical tags, the sitemap and the payment callback.
 *
 * The redirect is deliberately a 301 and deliberately path-and-query preserving:
 * a shared product link must land on the same product, not on the home page.
 */

export const CANONICAL_ORIGIN = 'https://shop.ozikoro.com';

/** Hosts that must redirect to the canonical one. */
const ALIAS_HOSTS = new Set(['store.ozikoro.com']);

/**
 * The canonical URL for a request, when the request arrived on an alias.
 *
 * Returns null when no redirect is needed, so the caller does not have to
 * distinguish "already canonical" from "not a host we manage".
 */
export function canonicalRedirect(request: Request): string | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }

  if (!ALIAS_HOSTS.has(url.hostname)) return null;

  // A 301, because this is permanent and search engines should move their index.
  // The path and the query string are carried over untouched.
  return `${CANONICAL_ORIGIN}${url.pathname}${url.search}`;
}
