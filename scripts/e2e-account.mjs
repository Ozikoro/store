import fs from 'node:fs';
import { requireShopOpen, startBrowser, sleep } from './lib/browser.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'https://shop.ozikoro.com').replace(/\/+$/, '');
const SHOTS = arg('shots', '.e2e-account');
const EMAIL = process.env['E2E_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';

if (!EMAIL || !PASSWORD) {
  console.error('E2E_EMAIL and E2E_PASSWORD must be set.');
  process.exit(2);
}

// The shared session allocates its own free port and retries the launch; see
// `scripts/lib/browser.mjs` for why guessing a port broke chained runs.
await requireShopOpen(BASE);
const session = await startBrowser({ label: 'acct', shots: SHOTS, windowSize: '1440,1000' });
const { evaluate, goto, waitFor, shot, close } = session;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

try {
  // 1. Sign in through the real form.
  await goto(`${BASE}/account`);
  await evaluate(`(() => {
    const set = (selector, value) => {
      const el = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('[data-testid="account-email"]', ${JSON.stringify(EMAIL)});
    set('[data-testid="account-password"]', ${JSON.stringify(PASSWORD)});
    document.querySelector('[data-testid="account-submit"]').click();
    return true;
  })()`);
  // The form reloads the page on success, so wait for the signed-in page rather
  // than reading the old document.
  let signedIn = false;
  for (let i = 0; i < 40 && !signedIn; i += 1) {
    await sleep(500);
    signedIn = (await evaluate(
      "!!document.querySelector('[data-testid=\"sign-out\"]')"
    )) === true;
  }
  check('a staff account can sign in', signedIn === true);
  await shot('01-account-signed-in');

  // 2. The account page offers the admin link, because the account is staff.
  const adminLink = await evaluate(`!!document.querySelector('[data-testid="nav-admin"]')`);
  check('a staff account is offered the admin link', adminLink === true);

  // 3. The dashboard loads with money on it.
  await goto(`${BASE}/admin`);
  const body = await evaluate('document.body.innerText');
  const hasRevenue = /Revenue|Gross|₦/.test(body ?? '');
  check('the admin dashboard shows figures', hasRevenue === true, (body ?? '').slice(0, 60).replace(/\n/g, ' '));
  await shot('02-admin-dashboard');

  // 4. Each admin screen loads for a super admin.
  for (const [label, url, needle] of [
    ['orders', '/admin/orders', 'Orders'],
    ['products', '/admin/products', 'Products'],
    ['discounts', '/admin/discounts', 'Discount'],
    ['audit', '/admin/audit', 'Audit'],
    ['permissions', '/admin/permissions', 'Permissions'],
  ]) {
    await goto(`${BASE}${url}`);
    // The admin shell resolves the session on the CLIENT, so the first paint says
    // "Checking your access…". Reading the page immediately reported a screen that
    // was still loading as broken — it happened about once in three chained runs.
    //
    // The screens themselves are fast: measured against production, every one of
    // these settles in under a second. So a screen still resolving after a long
    // wait is transient browser slowness, not the store — and it gets ONE reload
    // before being called a failure, because a flaky harness teaches people to
    // ignore the suite.
    let settled = await waitFor('[data-testid="admin-page-title"]', 40);
    if (!settled) {
      await goto(`${BASE}${url}`, 400);
      settled = await waitFor('[data-testid="admin-page-title"]', 40);
    }
    const text = await evaluate('document.body.innerText');
    const stillChecking = /Checking your access/i.test(text ?? '');
    const ok = (text ?? '').includes(needle) && !stillChecking && !(text ?? '').includes('AdminNot authorised');
    check(
      `admin ${label} screen loads`,
      ok,
      ok ? '' : stillChecking ? 'still resolving access after two attempts' : (text ?? '').slice(0, 70).replace(/\n/g, ' ')
    );
  }
  await shot('03-admin-permissions');

  // 5. The permissions screen lists the owner, who must now hold a role.
  const staffRow = await evaluate(
    `document.querySelector('[data-testid^="staff-"]')?.getAttribute('data-testid') ?? 'none'`
  );
  check('the permissions screen lists a staff account', staffRow !== 'none', staffRow);

  // 6. A RECORD'S OWN PAGE RENDERS — the check that was missing.
  //
  // `/admin/orders/$number` and `/admin/products/$slug` are CHILDREN of their
  // list routes. A parent route that renders a component without an `<Outlet />`
  // swallows the child, so opening a record showed the LIST again: the URL
  // changed, the page did not. Both parents did exactly that, and nothing caught
  // it, because the list is plausible at that URL and the earlier check here only
  // looked for a form — which the list also has.
  //
  // Each of these asserts on something only the DETAIL page has.
  await goto(`${BASE}/admin/orders`);
  // The list is a CLIENT-side query with a status filter, so it is empty on the
  // first paint and a cancelled test order may not match the default. Wait for a
  // row, and ask for every status so the check does not depend on which orders
  // happen to be left over from earlier runs.
  await waitFor('[data-testid^="order-row-"]', 40);
  let firstOrder = await evaluate(
    `document.querySelector('[data-testid^="order-row-"]')?.getAttribute('data-testid')?.replace('order-row-','') ?? ''`
  );
  if (!firstOrder) {
    // Nothing matched the default filter; widen it and try once more.
    await fill('[data-testid="orders-status"]', 'all');
    await click('[data-testid="orders-filter-submit"]');
    await waitFor('[data-testid^="order-row-"]', 40);
    firstOrder = await evaluate(
      `document.querySelector('[data-testid^="order-row-"]')?.getAttribute('data-testid')?.replace('order-row-','') ?? ''`
    );
  }
  check('the orders list offers an order to open', firstOrder.length > 0, firstOrder || 'none listed after widening the filter');

  if (firstOrder) {
    await goto(`${BASE}/admin/orders/${firstOrder}`);
    // The page loads its detail from a client-side query, so wait for it.
    let detailReady = false;
    for (let i = 0; i < 40 && !detailReady; i += 1) {
      await sleep(500);
      detailReady = (await evaluate(`!!document.querySelector('[data-testid="panel-payments"]')`)) === true;
    }
    const panels = await evaluate(
      `JSON.stringify([...document.querySelectorAll('[data-testid^="panel-"]')].map((el) => el.getAttribute('data-testid')))`
    );
    const text = await evaluate(`document.querySelector('main')?.innerText ?? ''`);
    check(
      `the order detail page renders order ${firstOrder}`,
      detailReady === true && (text ?? '').includes(firstOrder),
      detailReady ? 'panels rendered' : 'the detail never loaded'
    );
    check(
      'the order detail page does not show the orders list',
      !(text ?? '').includes('Every order, newest first'),
      (text ?? '').slice(0, 60).replace(/\n/g, ' ')
    );
    check(
      'the order detail page shows its panels',
      /panel-payments/.test(panels ?? '') && /panel-items/.test(panels ?? ''),
      (panels ?? '').slice(0, 120)
    );
    await shot('04-admin-order-detail');
  }

  await goto(`${BASE}/admin/products`);
  // Same as the orders list: a client-side query with a status filter, so it is
  // empty on the first paint and the default filter may exclude everything.
  await waitFor('[data-testid^="product-row-"]', 40);
  let firstProduct = await evaluate(
    `document.querySelector('[data-testid^="product-row-"]')?.getAttribute('data-testid')?.replace('product-row-','') ?? ''`
  );
  if (!firstProduct) {
    await fill('[data-testid="products-status"]', 'all');
    await click('[data-testid="products-filter-submit"]');
    await waitFor('[data-testid^="product-row-"]', 40);
    firstProduct = await evaluate(
      `document.querySelector('[data-testid^="product-row-"]')?.getAttribute('data-testid')?.replace('product-row-','') ?? ''`
    );
  }
  check(
    'the products list offers a product to open',
    firstProduct.length > 0,
    firstProduct || 'none listed after widening the filter'
  );

  if (firstProduct) {
    await goto(`${BASE}/admin/products/${firstProduct}`);
    let editorReady = false;
    for (let i = 0; i < 40 && !editorReady; i += 1) {
      await sleep(500);
      editorReady = (await evaluate(`!!document.querySelector('[data-testid="product-category"]')`)) === true;
    }
    const text = await evaluate(`document.querySelector('main')?.innerText ?? ''`);
    check(
      `the product editor renders ${firstProduct}`,
      editorReady === true,
      editorReady ? 'the editor is up' : 'the editor never loaded'
    );
    check(
      'the product editor does not show the products list',
      !(text ?? '').includes('every product'),
      (text ?? '').slice(0, 60).replace(/\n/g, ' ')
    );
    await shot('04-admin-product-editor');
  }

  // 7. The audit log records the work done so far.
  await goto(`${BASE}/admin/audit`);
  // The rows arrive from a client-side query, so they are NOT in the first HTML.
  // Reading the DOM immediately saw "Loading the trail…" and reported an empty
  // log. Wait for a row or for the screen to say there is nothing.
  //
  // The wait is longer than it looks like it needs to be, on purpose. The shell
  // resolves access first and only then fires the audit query, so this screen is
  // two round trips behind the others — and it was the one still flaking in a
  // chained run. A screen that is genuinely empty says so, which is also accepted
  // here, so waiting longer cannot turn a real failure into a pass.
  for (let i = 0; i < 60; i += 1) {
    const ready = await evaluate(`(() => {
      const hasRow = !!document.querySelector('[data-testid^="audit-entry-"]');
      const saysEmpty = /Nothing has been recorded/i.test(document.querySelector('main')?.innerText ?? '');
      const errored = !!document.querySelector('[data-testid="admin-error"]');
      return hasRow || saysEmpty || errored;
    })()`);
    if (ready) break;
    await sleep(500);
  }
  // Read the audit rows themselves. An earlier version of this check regexed
  // `document.body.innerText` for action verb prefixes, which matched the word
  // "Product" in the navigation and passed while telling us nothing.
  // Count the rendered rows. Two earlier versions of this check parsed the
  // page text: the first matched the word "Product" in the navigation, and the
  // second required a `.` followed by lowercase letters, which did not match
  // `seo.setting_changed` because of the underscore. Counting elements asks the
  // question directly.
  const audit = await evaluate(`(() => {
    const rows = document.querySelectorAll('[data-testid^="audit-entry-"]');
    const actions = [...rows].map((row) => row.querySelector('.font-mono')?.textContent ?? '').filter(Boolean);
    return {
      count: rows.length,
      sample: [...new Set(actions)].slice(0, 4).join(', '),
      empty: /Nothing has been recorded/i.test(document.querySelector('main')?.innerText ?? ''),
    };
  })()`);
  check(
    'the audit log lists changes',
    audit.count > 0,
    audit.count > 0 ? `${audit.count} entries: ${audit.sample}` : audit.empty ? 'the screen says there are none' : 'no rows rendered'
  );
  await shot('05-admin-audit');

  // 8. No console errors on the signed-in path either.
  const realErrors = session.consoleErrors.filter((line) => !/favicon|fonts\.googleapis/.test(line));
  check('no console errors while signed in', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

  // 9. Signing out takes the admin link away again.
  await goto(`${BASE}/account`);
  const hadButton = await evaluate(`!!document.querySelector('[data-testid="sign-out"]')`);
  await evaluate(`(() => {
    const button = document.querySelector('[data-testid="sign-out"]');
    if (button) button.click();
    return true;
  })()`);
  await sleep(6000);
  check('signing out is offered', hadButton === true);
  await goto(`${BASE}/account`);
  const gateAfter = await evaluate(`document.body.innerText.includes('Sign in')`);
  check('after signing out the account asks for sign-in', gateAfter === true);
} catch (error) {
  /*
   * An exception ANYWHERE in the suite lands here, and this must not exit 0.
   *
   * These suites end in `finally { … process.exit(failed.length ? 1 : 0) }`, and
   * `finally` runs after a thrown error. So an exception that escaped the body —
   * a navigation that never settled, a page that stopped rendering, a store that
   * was closed — reached the summary with ZERO recorded checks, printed
   * "0/0 checks passed", and exited 0. A clean green exit for a suite that never
   * ran a single assertion.
   *
   * It is recorded as a failed check rather than only printed, so the exit code
   * and the summary agree with each other.
   */
  const message = error instanceof Error ? `${error.message}` : String(error);
  console.error(`\nSUITE ABORTED before finishing: ${message}`);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(0, 4).join('\n'));
  check('the suite ran to completion', false, message);
} finally {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  console.log(`Screenshots in ${SHOTS}/`);
  await close();
  process.exit(failed.length ? 1 : 0);
}
