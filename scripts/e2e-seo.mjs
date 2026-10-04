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
  return { status: response.status, html, head };
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
