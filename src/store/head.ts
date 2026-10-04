/**
 * Head helpers.
 *
 * Every page returns unique metadata, a canonical URL and — where it is a
 * product — structured data, because the handoff requires product pages to be
 * crawlable and shareable. Canonical URLs are absolute and derive from
 * `STORE_ORIGIN`, so a preview deployment does not compete with production in
 * search results.
 */

export const STORE_ORIGIN = 'https://shop.ozikoro.com';

export function absoluteUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${STORE_ORIGIN}${clean === '/' ? '' : clean}`;
}

export function storeHead(input: {
  title: string;
  description: string;
  path: string;
  type?: 'website' | 'product' | 'article';
  image?: string;
}) {
  const url = absoluteUrl(input.path);
  const fullTitle = input.title.includes('Ozikoro') ? input.title : `${input.title} | Ozikoro Store`;
  const image = input.image
    ? input.image.startsWith('http')
      ? input.image
      : absoluteUrl(input.image)
    : absoluteUrl('/brand/ozikoro-square.svg');

  return {
    meta: [
      { title: fullTitle },
      { name: 'description', content: input.description },
      { property: 'og:title', content: fullTitle },
      { property: 'og:description', content: input.description },
      { property: 'og:type', content: input.type ?? 'website' },
      { property: 'og:url', content: url },
      { property: 'og:site_name', content: 'Ozikoro Store' },
      { property: 'og:image', content: image },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: fullTitle },
      { name: 'twitter:description', content: input.description },
      { name: 'twitter:image', content: image },
    ],
    links: [{ rel: 'canonical', href: url }],
  };
}

/**
 * schema.org Product, for a rich result.
 *
 * The offer list is built from the real variants, so the price a search engine
 * shows is the price the store will charge. `availability` is derived from live
 * stock rather than assumed — telling Google something is InStock when it is
 * not is how a shop earns a "product unavailable" reputation.
 */
export function productStructuredData(input: {
  name: string;
  description: string;
  image: string;
  path: string;
  sku: string;
  brand?: string;
  currency: string;
  offers: Array<{ sku: string; name: string; priceMinor: number; inStock: boolean }>;
}): string {
  const prices = input.offers.map((offer) => offer.priceMinor);
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: input.name,
    description: input.description,
    image: [input.image.startsWith('http') ? input.image : absoluteUrl(input.image)],
    sku: input.sku,
    brand: { '@type': 'Brand', name: input.brand ?? 'Ozikoro' },
    url: absoluteUrl(input.path),
  };
  if (prices.length) {
    data['offers'] = {
      '@type': 'AggregateOffer',
      priceCurrency: input.currency,
      lowPrice: (Math.min(...prices) / 100).toFixed(2),
      highPrice: (Math.max(...prices) / 100).toFixed(2),
      offerCount: prices.length,
      availability: input.offers.some((offer) => offer.inStock)
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      seller: { '@type': 'Organization', name: 'Ozikoro' },
    };
  }
  return JSON.stringify(data);
}

/** schema.org Organization, on the home page. */
export function organisationStructuredData(): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Ozikoro',
    url: 'https://ozikoro.com',
    logo: absoluteUrl('/brand/ozikoro-square.svg'),
    sameAs: ['https://ozikoro.com'],
    department: { '@type': 'Store', name: 'Ozikoro Store', url: STORE_ORIGIN },
  });
}

/** The breadcrumb trail a product or collection page carries. */
export function breadcrumbStructuredData(trail: Array<{ name: string; path: string }>): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      url: absoluteUrl(item.path),
    })),
  });
}
