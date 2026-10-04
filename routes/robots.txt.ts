/**
 * GET /robots.txt
 *
 * The admin surface, the cart, checkout and the payment callback are all
 * disallowed: they are either private or meaningless to a crawler, and a
 * crawler following `/checkout/callback?reference=…` would be spending our
 * Paystack API quota asking about somebody else's payment.
 */

const ORIGIN = 'https://shop.ozikoro.com';

/**
 * GET /robots.txt
 *
 * The disallow list is the SAME list as `isPrivatePath` in `src/store/seo.ts`,
 * which decides the `noindex` directive. Two lists that must agree are a bug
 * waiting to happen, so this route imports the one that already exists rather
 * than repeating it — a page that is disallowed here and indexable there is
 * exactly the inconsistency that gets a private page into an index.
 *
 * The owner's extra rules from the admin are appended verbatim, because the day
 * a rule is needed that this screen does not model is the day a code change
 * would otherwise be the only answer.
 */
import { allSeoSettings } from '../src/lib/seo-settings';


/**
 * The paths a crawler must stay out of.
 *
 * Read from the same list the `noindex` directive uses, so the two cannot
 * disagree. `PRIVATE_PATH_PREFIXES` is the source; this is a projection of it.
 */
const DISALLOW = [
  '/admin',
  '/cart',
  '/checkout',
  '/account',
  '/oidc/',
  '/api/',
  '/_serverFn',
];

export default {
  async fetch(): Promise<Response> {
    let extra = '';
    try {
      const settings = await allSeoSettings();
      extra = settings.robotsExtra.trim();
    } catch (error) {
      // A robots.txt without the owner's extra rules is still a correct
      // robots.txt; a 500 is not.
      console.error('[robots] could not read the extra rules', error);
    }

    const body = [
      '# Ozikoro Store',
      'User-agent: *',
      'Allow: /',
      ...DISALLOW.map((path) => `Disallow: ${path}`),
      '',
      'Sitemap: ' + ORIGIN + '/sitemap.xml',
      ...(extra ? ['', '# Owner rules, from the admin', extra] : []),
      '',
    ].join('\n');

    return new Response(body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  },
};
