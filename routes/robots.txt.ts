/**
 * GET /robots.txt
 *
 * The admin surface, the cart, checkout and the payment callback are all
 * disallowed: they are either private or meaningless to a crawler, and a
 * crawler following `/checkout/callback?reference=…` would be spending our
 * Paystack API quota asking about somebody else's payment.
 */

const ORIGIN = 'https://shop.ozikoro.com';

const BODY = `# Ozikoro Store
User-agent: *
Allow: /
Disallow: /admin
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /api/

Sitemap: ${ORIGIN}/sitemap.xml
`;

export default {
  fetch(): Response {
    return new Response(BODY, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  },
};
