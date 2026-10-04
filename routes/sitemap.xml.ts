/**
 * GET /sitemap.xml
 *
 * Generated from the live catalogue, so a product added in the admin appears in
 * the sitemap without a deploy. Only `active` products are listed — a draft must
 * not be advertised to a crawler, and neither must an archived one.
 *
 * The cache header is short (ten minutes) because the whole point of generating
 * this is that it follows the catalogue; a daily cache would mean a new product
 * waits a day to be discoverable.
 */

import { listProducts, listCollections } from '../src/lib/catalog';

const ORIGIN = 'https://shop.ozikoro.com';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function url(loc: string, priority: string, changefreq: string, lastmod?: string): string {
  return [
    '  <url>',
    `    <loc>${escapeXml(ORIGIN + loc)}</loc>`,
    lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
    `    <changefreq>${changefreq}</changefreq>`,
    `    <priority>${priority}</priority>`,
    '  </url>',
  ]
    .filter(Boolean)
    .join('\n');
}

function isoDay(value: string): string {
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(parsed) ? new Date().toISOString().slice(0, 10) : new Date(parsed).toISOString().slice(0, 10);
}

export default {
  async fetch(): Promise<Response> {
    const entries: string[] = [
      url('/', '1.0', 'weekly'),
      url('/shop', '0.9', 'weekly'),
      url('/collections', '0.8', 'weekly'),
      url('/about', '0.5', 'monthly'),
      url('/contact', '0.5', 'monthly'),
      url('/shipping-returns', '0.4', 'monthly'),
      url('/refunds', '0.4', 'monthly'),
      url('/privacy', '0.3', 'yearly'),
      url('/terms', '0.3', 'yearly'),
    ];

    try {
      const [products, collections] = await Promise.all([listProducts({ limit: 200 }), listCollections()]);

      for (const collection of collections) {
        entries.push(url(`/collections/${collection.slug}`, '0.8', 'weekly', isoDay(collection.updated_at)));
      }
      for (const product of products) {
        entries.push(url(`/products/${product.slug}`, '0.7', 'weekly', isoDay(product.updated_at)));
      }
    } catch (error) {
      // A sitemap missing its deep links is better than a 500 that a crawler
      // reads as "this site is broken". The static entries above still serve.
      console.error('[sitemap] catalogue unavailable, serving the static entries only', error);
    }

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      ...entries,
      '</urlset>',
      '',
    ].join('\n');

    return new Response(xml, {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'public, max-age=600, s-maxage=600',
      },
    });
  },
};
