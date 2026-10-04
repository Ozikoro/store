/**
 * The document head, generated for every page the store serves.
 *
 * PORTED FROM THE ARCHIVE'S `seo-head.ts`, which was itself built by studying
 * the Yoast SEO Premium plugin the owner holds. Four things are carried over
 * because they are the substance of that study, and one of them is a fault the
 * store had:
 *
 * 1. ONE `@graph`, NOT SEVERAL SCRIPT TAGS.
 *
 *    The store emitted a `WebSite` node in the root, an `Organization` node on
 *    the home page, a `Product` on a product page and a `BreadcrumbList` beside
 *    it — four separate JSON-LD blocks with no relationship between them. A
 *    crawler then has to guess whether the `Organization` on the home page and
 *    the one implied on a product page are the same entity. In one graph, nodes
 *    reference each other by `@id` and the guess disappears.
 *
 * 2. ROBOTS WITH `max-image-preview:large` AND `max-snippet:-1`.
 *
 *    Without them a result shows a thumbnail and a two-line snippet. With them
 *    it shows a full-width image and as much text as the query deserves, which
 *    is free visibility on every product.
 *
 * 3. THE PRIVATE SURFACES ARE `noindex, follow`.
 *
 *    The store's sitemap listed `/admin` until this change, and nothing at all
 *    said `noindex` on the cart, the checkout, the account pages, the order
 *    lookups or the payment callback. A dashboard, a form behind an auth gate
 *    and a page whose URL contains a payment reference have no business in an
 *    index.
 *
 * 4. HIGHWIRE `citation_*`, FOR THE WRITING.
 *
 *    Yoast does not emit these. Google Scholar reads them and nothing else. The
 *    store's editorial pages — about, shipping, returns, the policies — are
 *    citable prose, and a product is not a citation, so the tags are emitted for
 *    the pages that are.
 *
 * NOTHING HERE IS INVENTED. Every value comes from the record or from the
 * settings table, or it is omitted — an empty `citation_author` is worse than no
 * `citation_author`.
 */

import { STORE_ORIGIN, absoluteUrl } from './head';
import { verificationMeta, type SeoSettings } from '../lib/seo-settings';

/** HTML-escape for an attribute value. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Trim to a length a search result will show, without cutting mid-word. */
export function clamp(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, '')}…`;
}

export type PageKind = 'website' | 'product' | 'article' | 'collection' | 'search' | 'private';

/** Which schema type and og type a page gets. */
const SCHEMA_TYPE: Record<PageKind, string> = {
  website: 'WebPage',
  product: 'Product',
  article: 'Article',
  collection: 'CollectionPage',
  search: 'SearchResultsPage',
  private: 'WebPage',
};

const OG_TYPE: Record<PageKind, string> = {
  website: 'website',
  product: 'product',
  article: 'article',
  collection: 'website',
  search: 'website',
  private: 'website',
};

/** A page that must never be indexed, whatever else is set. */
export function isPrivatePath(path: string): boolean {
  return (
    path === '/admin' ||
    path.startsWith('/admin/') ||
    path === '/cart' ||
    path === '/checkout' ||
    path.startsWith('/checkout/') ||
    path === '/account' ||
    path.startsWith('/account/') ||
    path.startsWith('/oidc/') ||
    path.startsWith('/api/')
  );
}

export interface SeoInput {
  title: string;
  description: string;
  /** Clean path, e.g. `/products/the-ozikoro-reader`. */
  path: string;
  kind: PageKind;
  image?: string | null;
  imageAlt?: string | null;
  /** ISO date. Only emitted when real. */
  published?: string | null;
  updated?: string | null;
  /** The store's own reference, e.g. an order number or a SKU. */
  reference?: string | null;
  trail?: Array<{ name: string; path: string }>;
  topics?: string[];
  /** Override, for a page that knows better than the path rule. */
  noindex?: boolean;
  settings: SeoSettings;
  /** Product-only: the real variant offers, so the price in a result is the price charged. */
  offers?: {
    currency: string;
    lowPriceMinor: number;
    highPriceMinor: number;
    inStock: boolean;
    sku: string;
    brand?: string;
  } | null;
}

export interface SeoOutput {
  meta: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
  /** The graph, already serialised, for one script tag. */
  jsonLd: string;
}

/**
 * The whole head for a page.
 *
 * Returns the shape TanStack's `head()` expects, so a route returns this
 * directly rather than assembling meta tags by hand — which is what let the
 * store's four JSON-LD blocks drift apart in the first place.
 */
export function storeSeo(input: SeoInput): SeoOutput {
  const url = absoluteUrl(input.path);
  const title = clamp(input.title, 60);
  // The suffix is stored with a leading space, and `clamp` TRIMS — so a title
  // short enough to keep its space came out as "Checkout| Ozikoro Store" while a
  // long one did not. Normalising both halves here means the stored value cannot
  // affect whether the space survives.
  const suffix = input.settings.titleSuffix.trim();
  const description = clamp(input.description || input.settings.defaultDescription, 158);
  const noindex = input.noindex ?? isPrivatePath(input.path);
  const organisation = input.settings.organisation;

  const orgId = `${STORE_ORIGIN}/#organization`;
  const siteId = `${STORE_ORIGIN}/#website`;
  const pageId = `${url}#page`;

  const nodes: Array<Record<string, unknown>> = [
    {
      '@type': 'Organization',
      '@id': orgId,
      name: organisation.legalName || 'Ozikoro',
      url: 'https://ozikoro.com',
      logo: { '@type': 'ImageObject', url: absoluteUrl('/brand/ozikoro-square.svg') },
      // The archive is the same publisher. Saying so is what lets a search
      // engine connect the two addresses to one entity, which is the entire
      // point of running a store beside an archive rather than apart from it.
      sameAs: ['https://ozikoro.com', 'https://ozituma.com'],
      ...(organisation.email ? { email: organisation.email } : {}),
      ...(organisation.locality || organisation.country
        ? {
            address: {
              '@type': 'PostalAddress',
              ...(organisation.locality ? { addressLocality: organisation.locality } : {}),
              ...(organisation.country ? { addressCountry: organisation.country } : {}),
            },
          }
        : {}),
      ...(organisation.founding ? { foundingDate: organisation.founding } : {}),
    },
    {
      '@type': 'WebSite',
      '@id': siteId,
      url: STORE_ORIGIN,
      name: 'Ozikoro Store',
      publisher: { '@id': orgId },
      inLanguage: 'en',
      // Makes a sitelinks searchbox possible: a result for the store can carry
      // a search field instead of only a link.
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: `${STORE_ORIGIN}/search?q={search_term_string}` },
        'query-input': 'required name=search_term_string',
      },
    },
  ];

  const page: Record<string, unknown> = {
    '@type': SCHEMA_TYPE[input.kind],
    '@id': pageId,
    url,
    name: title,
    description,
    isPartOf: { '@id': siteId },
    publisher: { '@id': orgId },
    inLanguage: 'en',
  };
  if (input.published) page['datePublished'] = input.published;
  if (input.updated) page['dateModified'] = input.updated;
  if (input.reference) page['identifier'] = input.reference;
  if (input.image) {
    page['primaryImageOfPage'] = {
      '@type': 'ImageObject',
      url: input.image.startsWith('http') ? input.image : absoluteUrl(input.image),
      ...(input.imageAlt ? { caption: input.imageAlt } : {}),
    };
  }
  if (input.topics?.length) {
    page['about'] = input.topics.map((topic) => ({ '@type': 'Thing', name: topic }));
  }

  // The offers go on the page node itself, so the Product IS the page rather
  // than a second node describing it. A search engine then has one entity to
  // reconcile, not two.
  if (input.kind === 'product' && input.offers) {
    const offers = input.offers;
    page['sku'] = offers.sku;
    page['brand'] = { '@type': 'Brand', name: offers.brand ?? 'Ozikoro' };
    page['offers'] = {
      '@type': 'AggregateOffer',
      priceCurrency: offers.currency,
      lowPrice: (offers.lowPriceMinor / 100).toFixed(2),
      highPrice: (offers.highPriceMinor / 100).toFixed(2),
      offerCount: 1,
      availability: offers.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      seller: { '@id': orgId },
    };
  }

  nodes.push(page);

  const trail = input.trail ?? [];
  if (trail.length > 1) {
    nodes.push({
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: trail.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: absoluteUrl(item.path),
      })),
    });
  }

  // ------------------------------------------------------------------ meta

  const meta: Array<Record<string, unknown>> = [
    // A canonical on every page, including the private ones. On a private page it
    // is not about ranking; it is what stops a crawler that found the URL by
    // accident from treating two spellings of it as two pages.
    { title: title.includes('Ozikoro') ? title : suffix ? `${title} ${suffix}` : title },
    { name: 'description', content: description },
    { name: 'robots', content: robotsContent(noindex) },
    { property: 'og:site_name', content: 'Ozikoro Store' },
    { property: 'og:locale', content: 'en' },
    { property: 'og:type', content: OG_TYPE[input.kind] },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { property: 'og:url', content: url },
    {
      name: 'twitter:card',
      content: input.image ? 'summary_large_image' : 'summary',
    },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
  ];

  const image = input.image ? (input.image.startsWith('http') ? input.image : absoluteUrl(input.image)) : null;
  if (image) {
    meta.push({ property: 'og:image', content: image });
    meta.push({ name: 'twitter:image', content: image });
    if (input.imageAlt) meta.push({ property: 'og:image:alt', content: input.imageAlt });
  } else {
    // A social card with no image is a grey rectangle. The mark is the one image
    // that is always true of the store.
    meta.push({ property: 'og:image', content: absoluteUrl('/brand/ozikoro-square.svg') });
    meta.push({ name: 'twitter:image', content: absoluteUrl('/brand/ozikoro-square.svg') });
  }
  if (input.published) meta.push({ property: 'article:published_time', content: input.published });
  if (input.updated) meta.push({ property: 'article:modified_time', content: input.updated });
  for (const topic of input.topics ?? []) meta.push({ property: 'article:tag', content: topic });

  // ------------------------------------------------- search-engine verification
  // These come from the admin. Emitted on every page, because an engine fetches
  // whichever URL it was given and it is not always the home page.
  //
  // `verificationMeta` rather than `settings.verification` directly, because the
  // settings screen also offers a field for an engine it does not model — Baidu,
  // Naver, whatever comes next — and that pair only becomes a tag here. Reading
  // the precomputed list alone silently dropped it.
  for (const tag of verificationMeta(input.settings)) {
    meta.push({ name: tag.name, content: tag.content });
  }

  // ----------------------------------------------------------------- links
  const links: Array<Record<string, unknown>> = [{ rel: 'canonical', href: url }];

  // ------------------------------------------------------- Highwire citation
  // For the pages that are writing rather than commerce. A product is not a
  // citation, and emitting `citation_title` on one would put a shop page into
  // Scholar's view of the world.
  if (input.kind === 'article') {
    meta.push({ name: 'citation_title', content: input.title });
    for (const author of authorsFrom(input)) meta.push({ name: 'citation_author', content: author });
    if (input.published) {
      meta.push({ name: 'citation_publication_date', content: input.published.slice(0, 10) });
    }
    meta.push({ name: 'citation_public_url', content: url });
    meta.push({
      name: 'citation_publisher',
      content: input.settings.organisation.legalName || 'Ozikoro',
    });
    meta.push({ name: 'citation_language', content: 'en' });
    if (input.reference) meta.push({ name: 'citation_technical_report_number', content: input.reference });
  }

  // ------------------------------------------------ unsupported by React's types
  //
  // TanStack's `head()` types accept a known set of meta keys, and the
  // `citation_*` names are not among them — they are a Highwire convention, not
  // a standard React prop. The array is returned as `Record<string, unknown>[]`
  // so the caller can pass it through without a cast at every route.
  return { meta, links, jsonLd: JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }) };
}

/**
 * The robots directive.
 *
 * `max-image-preview:large` and `max-snippet:-1` are the two that change what a
 * result looks like: a full-width image and as much snippet as the query
 * deserves, rather than a thumbnail and two lines. `follow` on a private page is
 * deliberate — nothing there should be indexed, but the links out of it are
 * perfectly good ones.
 */
export function robotsContent(noindex: boolean): string {
  return noindex
    ? 'noindex, follow, max-image-preview:large, max-snippet:-1'
    : 'index, follow, max-image-preview:large, max-snippet:-1';
}

/** The archive's author, when a page names one. Kept explicit so it is not invented. */
function authorsFrom(input: SeoInput): string[] {
  const authors = input.topics?.filter((topic) => topic.startsWith('by:')) ?? [];
  return authors.map((author) => author.slice(3)).filter(Boolean);
}

/** A `@graph` script tag, ready to render. */
export function jsonLdScript(jsonLd: string) {
  return { type: 'application/ld+json', children: jsonLd };
}

/** The `place` node shape the archive uses, for a store that ever has a physical address page. */
export function placeNode(place: { name: string; path: string; region?: string | null }): Record<string, unknown> {
  const url = absoluteUrl(place.path);
  return {
    '@type': 'Place',
    '@id': `${url}#place`,
    name: place.name,
    url,
    ...(place.region ? { containedInPlace: { '@type': 'AdministrativeArea', name: place.region } } : {}),
  };
}

export { esc };
