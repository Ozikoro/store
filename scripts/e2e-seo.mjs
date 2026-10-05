#!/usr/bin/env node
/**
 * End-to-end check of the store's SEO.
 *
 * WHY EVERY CHECK IS HERE, AND WHY MOST OF THEM ARE ABOUT ABSENCE
 *
 * A head that emits too LITTLE is a missed opportunity. A head that emits the
 * wrong thing — two canonical URLs, two graphs describing two entities, a
 * private page in the sitemap — actively removes the site from a result. So most
 * of these assert that something is NOT there, or that exactly one of it is.
 *
 * The checks come from the archive's `seo-head.ts`, which was built by studying
 * the Yoast SEO Premium plugin the owner holds:
 *
 *   one @graph, not several script tags      two graphs are two entities
 *   exactly one canonical per page           two canonicals make one ignored
 *   robots with max-image-preview and snippet  a full image and a long snippet
 *   noindex on every private surface         the admin, the cart, the checkout
 *   the sitemap excludes what robots excludes  a disallowed URL in a sitemap is
 *                                             an error an owner must read
 *   verification codes on EVERY page         an engine fetches whichever URL it
 *                                             was given, not always the root
 *   product offers from the real variants     the price in a result is the price
 *                                             charged
 *   Organization sameAs the sibling sites     one publisher, three addresses
 *
 * Usage: node scripts/e2e-seo.mjs [--url https://shop.ozikoro.com]
 */

const BASE = (() => {
  const index = process.argv.indexOf('--url');
  return (index === -1 ? 'https://shop.ozikoro.com' : process.argv[index + 1]).replace(/\/+$/, '');
})();

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function page(path) {
  const response = await fetch(`${BASE}${path}`);
  const html = await response.text();
  const head = html.slice(0, html.indexOf('</head>'));
  // The structured-data script, so a check can assert on what a crawler reads
  // rather than on what a reader sees.
  const graph = (html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/) ?? [])[1] ?? '';
  return { status: response.status, html, head, text: html, graph };
}

const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';
let databaseId = null;

/** Run one statement against D1, for fixtures the suite must plant itself. */
async function d1(sql) {
  if (!token || !accountId) throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  if (!databaseId) {
    const list = await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    databaseId = (list?.result ?? []).find((entry) => entry.name === databaseName)?.uuid;
    if (!databaseId) throw new Error(`No D1 database named "${databaseName}".`);
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(`d1 failed: ${JSON.stringify(body?.errors ?? response.status)}`);
  return body.result ?? [];
}

function count(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function metaContent(head, name) {
  for (const m of head.matchAll(/<meta\s+([^>]*?)\/?>/g)) {
    if (new RegExp(`name="${name}"`).test(m[1])) {
      return /content="([^"]*)"/.exec(m[1])?.[1] ?? null;
    }
  }
  return null;
}

function canonicalOf(head) {
  const hrefs = [...head.matchAll(/<link\s+([^>]*?)\/?>/g)]
    .filter((m) => /rel="canonical"/.test(m[1]))
    .map((m) => /href="([^"]*)"/.exec(m[1])?.[1] ?? '');
  return hrefs;
}

function graphOf(head) {
  const scripts = [...head.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  const out = [];
  for (const s of scripts) {
    try {
      out.push(JSON.parse(s[1]));
    } catch {
      out.push(null);
    }
  }
  return out;
}

async function main() {
  // ---------------------------------------------------------------- the graph

  const home = await page('/');
  check('the home page answers', home.status === 200, `status ${home.status}`);

  const homeGraphs = graphOf(home.head);
  check('exactly one JSON-LD block on the home page', homeGraphs.length === 1, `${homeGraphs.length} block(s)`);

  const graph = homeGraphs[0];
  check('the block is an @graph, not a loose node', Boolean(graph?.['@graph']), Object.keys(graph ?? {}).join(', '));

  const nodes = graph?.['@graph'] ?? [];
  const types = nodes.map((node) => node['@type']);
  check('the graph has an Organization', types.includes('Organization'), types.join(', '));
  check('the graph has a WebSite', types.includes('WebSite'));

  const organization = nodes.find((node) => node['@type'] === 'Organization');
  check(
    'the Organization names the publisher',
    typeof organization?.name === 'string' && organization.name.length > 0,
    String(organization?.name)
  );
  check(
    'the Organization claims the sibling platforms as itself',
    Array.isArray(organization?.sameAs) &&
      organization.sameAs.includes('https://ozikoro.com') &&
      organization.sameAs.includes('https://ozituma.com'),
    JSON.stringify(organization?.sameAs)
  );

  const website = nodes.find((node) => node['@type'] === 'WebSite');
  check('the WebSite carries a SearchAction for a sitelinks searchbox', Boolean(website?.potentialAction));
  check(
    'the WebSite is published by the Organization',
    website?.publisher?.['@id'] === organization?.['@id'],
    String(website?.publisher?.['@id'])
  );
  check(
    'every node is identifiable by @id',
    nodes.every((node) => typeof node['@id'] === 'string' && node['@id'].length > 0),
    nodes.filter((node) => !node['@id']).map((node) => node['@type']).join(', ')
  );

  // -------------------------------------------------------------- one canonical

  check('exactly one canonical on the home page', canonicalOf(home.head).length === 1, canonicalOf(home.head).join(' | '));
  check(
    'the canonical is absolute on the store origin',
    canonicalOf(home.head)[0]?.startsWith('https://shop.ozikoro.com'),
    String(canonicalOf(home.head)[0])
  );

  // ------------------------------------------- the canonical is the page itself
  //
  // This is the check that would have caught the worst bug in this file: reading
  // the path from `ctx.match` gave EVERY page a canonical URL pointing at the
  // home page, which tells a search engine that the whole store is a duplicate
  // of one page.
  for (const path of ['/shop', '/cart', '/products/the-ozikoro-reader', '/collections/apparel', '/about']) {
    const p = await page(path);
    const canonicals = canonicalOf(p.head);
    const expected = path === '/' ? 'https://shop.ozikoro.com' : `https://shop.ozikoro.com${path}`;
    check(
      `the canonical for ${path} is its own URL`,
      canonicals.length === 1 && canonicals[0] === expected,
      canonicals.join(' | ') || 'none'
    );
  }

  // ---------------------------------------------------------------- robots

  const homeRobots = metaContent(home.head, 'robots') ?? '';
  check('the home page is indexable', /index/.test(homeRobots) && !/noindex/.test(homeRobots), homeRobots);
  check('robots asks for a large image preview', /max-image-preview:large/.test(homeRobots), homeRobots);
  check('robots asks for an unlimited snippet', /max-snippet:-1/.test(homeRobots), homeRobots);

  // ------------------------------------------------------------------- private

  for (const path of ['/admin', '/cart', '/checkout', '/account']) {
    const p = await page(path);
    const robots = metaContent(p.head, 'robots') ?? '';
    check(`${path} is noindex`, /noindex/.test(robots), robots || 'no robots tag');
  }

  // ------------------------------------------------- every admin route refuses
  //
  // Signed out, an admin route must refuse — and must refuse WITHOUT a 500. The
  // SEO screen was the outlier: it let an AuthorizationError escape its loader
  // and answered 500 on a page whose whole job is to show a form. A refusal is a
  // normal outcome of asking, not a server fault, and a 500 is also what a
  // monitoring check reports as "the site is down".
  for (const path of [
    '/admin',
    '/admin/orders',
    '/admin/products',
    '/admin/discounts',
    '/admin/audit',
    '/admin/permissions',
    '/admin/seo',
  ]) {
    const response = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    check(
      `${path} refuses a signed-out visitor without a server error`,
      response.status >= 200 && response.status < 500,
      `status ${response.status}`
    );
  }

  // ------------------------------- a discontinued product gets an ARCHIVE PAGE
  //
  // The handoff asks for "useful redirects/archive pages for discontinued
  // products". A 404 discards every inbound link, bookmark and search result for
  // a thing that once existed, and tells the person following one nothing — so an
  // archived product renders instead, marked `noindex, follow` and carrying no
  // offer, because advertising a price for something that cannot be bought is
  // worse than advertising nothing.
  //
  // The fixture is created here and removed at the end, so a failure cannot leave
  // a retired product in the live shop.
  const archiveSlug = `e2e-archive-${Date.now().toString(36).slice(-6)}`;
  if (token && accountId) {
    try {
      await d1(
        `INSERT INTO products (id, slug, title, category, description, status, price_minor, currency)
         VALUES ('prd_${archiveSlug.replace(/-/g, '_')}', '${archiveSlug}', 'Retired Probe Piece',
                 'Prints & Posters', 'Archived by the SEO suite to check the archive page.', 'archived', 123400, 'NGN')`
      );

      const archived = await page(`/products/${archiveSlug}`);
      check(
        'an archived product is SERVED, not 404',
        archived.status === 200,
        `status ${archived.status} — a retired piece keeps its inbound links`
      );
      check(
        'the archive page says the piece is no longer available',
        /No longer available/i.test(archived.text)
      );

      const archivedRobots = metaContent(archived.head, 'robots') ?? '';
      check(
        'the archive page is noindex but its links are followed',
        /noindex/.test(archivedRobots) && /follow/.test(archivedRobots),
        archivedRobots
      );
      check(
        'the archive page still carries a canonical, so it is not a duplicate',
        canonicalOf(archived.head).length === 1 && canonicalOf(archived.head)[0].includes(archiveSlug),
        canonicalOf(archived.head).join(' | ')
      );
      check(
        'the archive page advertises NO offer',
        !/"offers"/.test(archived.graph ?? ''),
        'a price for something unbuyable is worse than no price'
      );
      check(
        'the archive page offers a route to what IS available',
        /Browse what is available|The shop/i.test(archived.text)
      );

      // A DRAFT must stay unreachable: it is a product somebody is still writing.
      await d1(
        `INSERT INTO products (id, slug, title, category, description, status, price_minor, currency)
         VALUES ('prd_draft_${archiveSlug.replace(/-/g, '_')}', 'draft-${archiveSlug}', 'Draft Probe Piece',
                 'Prints & Posters', 'Draft by the SEO suite.', 'draft', 123400, 'NGN')`
      );
      const draft = await page(`/products/draft-${archiveSlug}`);
      check(
        'a DRAFT product is not served at all',
        draft.status === 404,
        `status ${draft.status} — an unfinished product must not be reachable`
      );
    } finally {
      try {
        await d1(`DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE slug LIKE '%${archiveSlug}%' OR slug LIKE 'draft-${archiveSlug}')`);
        await d1(`DELETE FROM products WHERE slug LIKE '%${archiveSlug}%' OR slug LIKE 'draft-${archiveSlug}'`);
      } catch (error) {
        console.error('archive fixture cleanup failed:', error instanceof Error ? error.message : error);
      }
    }
  } else {
    console.log('      (archive checks skipped: CLOUDFLARE_API_TOKEN is not in this shell)');
  }

  // ------------------------------------ a parent route must not swallow a child
  //
  // THIS IS THE CHECK THAT MATTERS MOST IN THIS FILE. `checkout.tsx` rendered the
  // checkout form as its own component while `/checkout/callback` was its CHILD,
  // and a parent that renders a component WITHOUT an `<Outlet />` swallows that
  // child: the callback's loader still ran, so the page carried the right title
  // and description, while the confirmation component never mounted.
  //
  // The customer returning from Paystack was shown an empty checkout form
  // instead of their order. Nothing errored. The page looked plausible. A title
  // check would have passed it, which is why this asserts on the BODY: the
  // callback must say something only the callback can say.
  for (const [path, marker, why] of [
    ['/checkout/callback?reference=OZKNOSUCHREFERENCE', /could not (confirm|find) that payment/i, 'the payment verdict'],
    ['/checkout/callback?trxref=OZKNOSUCHREFERENCE&reference=OZKNOSUCHREFERENCE', /could not (confirm|find) that payment/i, "the payment verdict for Paystack's own return shape"],
    ['/checkout/callback', /could not (confirm|find) that payment/i, 'the verdict when no reference is given at all'],
  ]) {
    const response = await fetch(`${BASE}${path}`);
    const html = await response.text();
    const body = (html.match(/<main[\s\S]*?<\/main>/) ?? [''])[0];
    const ok = response.status === 200 && marker.test(body);
    check(
      `${path.split('?')[0]} renders its own body — ${why}`,
      ok,
      ok ? 'found the verdict' : response.status !== 200 ? `status ${response.status}` : 'the page showed another route'
    );
    check(
      `${path.split('?')[0]} does not show the checkout form`,
      !/Payment is taken on Paystack/.test(body)
    );
  }

  // The checkout form must still render at its own address, or the fix above
  // would have moved the problem rather than solved it.
  {
    const response = await fetch(`${BASE}/checkout`);
    const html = await response.text();
    const body = (html.match(/<main[\s\S]*?<\/main>/) ?? [''])[0];
    check(
      '/checkout still renders the checkout form',
      response.status === 200 && /Payment is taken on Paystack/.test(body),
      `status ${response.status}`
    );
  }

  // A callback must never be redirected: Paystack has already sent the customer,
  // and a redirect loses the reference.
  for (const path of ['/checkout/callback?trxref=X', '/checkout/callback?reference=X', '/checkout/callback']) {
    const response = await fetch(`${BASE}${path}`, { redirect: 'manual' });
    check(
      `${path} is answered directly, not redirected`,
      response.status === 200,
      `status ${response.status}${response.headers.get('location') ? ` -> ${response.headers.get('location')}` : ''}`
    );
  }

  // ---------------------------------------------------------------- sitemap

  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
  for (const forbidden of ['/admin', '/cart', '/checkout', '/account', '/oidc']) {
    check(
      `the sitemap does not list ${forbidden}`,
      !locs.some((loc) => loc.includes(forbidden)),
      locs.filter((loc) => loc.includes(forbidden)).join(', ')
    );
  }
  check('the sitemap lists the product pages', locs.filter((loc) => loc.includes('/products/')).length >= 9, `${locs.filter((loc) => loc.includes('/products/')).length} products`);
  check('the sitemap lists the collections', locs.filter((loc) => loc.includes('/collections/')).length >= 4);

  // ------------------------------------------- the canonical is the page itself
  //
  // This is the check that would have caught the worst bug in this file: reading
  // the path from `ctx.match` gave EVERY page a canonical URL pointing at the
  // home page, which tells a search engine that the whole store is a duplicate
  // of one page.
  for (const path of ['/shop', '/cart', '/products/the-ozikoro-reader', '/collections/apparel', '/about']) {
    const p = await page(path);
    const canonicals = canonicalOf(p.head);
    const expected = path === '/' ? 'https://shop.ozikoro.com' : `https://shop.ozikoro.com${path}`;
    check(
      `the canonical for ${path} is its own URL`,
      canonicals.length === 1 && canonicals[0] === expected,
      canonicals.join(' | ') || 'none'
    );
  }

  // ---------------------------------------------------------------- robots.txt

  const robotsTxt = await (await fetch(`${BASE}/robots.txt`)).text();
  check('robots.txt names the sitemap', robotsTxt.includes('Sitemap: https://shop.ozikoro.com/sitemap.xml'));
  check('robots.txt disallows the admin', /Disallow: \/admin/.test(robotsTxt));
  check('robots.txt disallows the RPC endpoint', /Disallow: \/_serverFn/.test(robotsTxt));

  // ------------------------------------------------ verification on every page

  const product = await page('/products/the-ozikoro-reader');

  // The verification codes are the owner's, read from the settings table, so
  // this test cannot assume any are configured. What it CAN assert
  // unconditionally is that none is empty — an empty tag is read by some engines
  // as a failed verification and by others as a claim — and that whatever IS
  // configured appears on more than one page, because an engine fetches whichever
  // URL it was given and that is not always the root.
  //
  // The round trip through the admin form, including that a saved code reaches
  // the live head, is `scripts/e2e-seo-admin.mjs`. That one sets its own code.
  const verificationNames = [
    ['Google', 'google-site-verification'],
    ['Yandex', 'yandex-verification'],
    ['Bing', 'msvalidate.01'],
    ['a custom engine', 'naver-site-verification'],
  ];
  let configured = 0;
  for (const [label, name] of verificationNames) {
    const onHome = metaContent(home.head, name);
    if (!onHome) continue;
    configured += 1;
    check(
      `${label} verification is not empty`,
      onHome.trim().length > 0,
      onHome.trim() ? 'present' : 'EMPTY'
    );
    check(
      `${label} verification also reaches a product page`,
      metaContent(product.head, name) === onHome,
      metaContent(product.head, name) ?? 'missing'
    );
  }
  check(
    'no empty verification tag is published on any page',
    !/<meta name="[^"]*verification[^"]*" content=""/.test(home.head + product.head)
  );
  console.log(
    configured === 0
      ? '      (no verification codes are configured yet — set them in Admin → SEO)'
      : `      (${configured} verification code(s) configured and emitted)`
  );

  // ------------------------------------------------------------ product offers

  const productGraphs = graphOf(product.head);
  check('a product page has exactly one graph', productGraphs.length === 1, `${productGraphs.length} block(s)`);
  const productNodes = productGraphs[0]?.['@graph'] ?? [];
  const productNode = productNodes.find((node) => node['@type'] === 'Product');
  check('the product is a Product node in the graph', Boolean(productNode), productNodes.map((n) => n['@type']).join(', '));
  check('the product node carries offers', Boolean(productNode?.offers), JSON.stringify(productNode?.offers ?? {}).slice(0, 60));
  check(
    'the offer prices come from the real variants',
    productNode?.offers?.lowPrice === '24000.00',
    `${productNode?.offers?.lowPrice}-${productNode?.offers?.highPrice}`
  );
  check(
    'availability is derived from stock',
    /InStock|OutOfStock/.test(String(productNode?.offers?.availability)),
    String(productNode?.offers?.availability).split('/').pop()
  );
  check('the product page has a breadcrumb in the graph', productNodes.some((node) => node['@type'] === 'BreadcrumbList'));
  check('the product page has one canonical', canonicalOf(product.head).length === 1, canonicalOf(product.head).join(' | '));

  // --------------------------------------------------------------- title rules

  const title = /<title[^>]*>([^<]*)</.exec(home.head)?.[1] ?? '';
  check('the title names the store', /Ozikoro/.test(title), title);
  check('the title is a length a result will show', title.length <= 70, `${title.length} characters`);

  const description = metaContent(home.head, 'description') ?? '';
  check('the description is set', description.length > 20, `${description.length} characters`);
  check('the description is a length a result will show', description.length <= 165, `${description.length} characters`);

  // ------------------------------------------------------------------- report

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
