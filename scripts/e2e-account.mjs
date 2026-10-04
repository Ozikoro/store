#!/usr/bin/env node
/**
 * End-to-end check of the signed-in surfaces: the customer account and the
 * admin dashboard.
 *
 * This runs after `scripts/e2e.mjs`, which covers the anonymous storefront. It
 * signs in as a real account and exercises the paths that need a session — which
 * cannot be reached with curl, because the server functions sit behind a CSRF
 * filter that (correctly) rejects a request without the site's own Origin.
 *
 * Usage:
 *   E2E_EMAIL=hello@ozikoro.com E2E_PASSWORD='…' node scripts/e2e-account.mjs \
 *     [--url https://shop.ozikoro.com] [--shots .e2e-account]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'https://shop.ozikoro.com').replace(/\/$/, '');
const SHOTS = arg('shots', '.e2e-account');
const EMAIL = process.env['E2E_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';

if (!EMAIL || !PASSWORD) {
  console.error('E2E_EMAIL and E2E_PASSWORD must be set.');
  process.exit(2);
}

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = 9900 + Math.floor(Math.random() * 90);
const chrome = spawn(
  CHROME,
  [
    '--headless=old',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/cdp-acct-${port}`,
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let target = null;
for (let i = 0; i < 50 && !target; i += 1) {
  await sleep(300);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  } catch {
    // not listening yet
  }
}
if (!target) {
  console.error('could not attach to Chrome');
  chrome.kill();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));

let messageId = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++messageId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response?.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
  return response?.result?.result?.value;
}

async function goto(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (await evaluate("document.readyState === 'complete' && !!document.querySelector('main')")) break;
  }
  await sleep(700);
}

async function shot(name) {
  const response = await send('Page.captureScreenshot', { format: 'png' });
  if (response?.result?.data) {
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(response.result.data, 'base64'));
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

await send('Page.enable');
await send('Runtime.enable');

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
    const text = await evaluate('document.body.innerText');
    const ok = (text ?? '').includes(needle) && !(text ?? '').includes('AdminNot authorised');
    check(`admin ${label} screen loads`, ok, ok ? '' : (text ?? '').slice(0, 70).replace(/\n/g, ' '));
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
  const firstOrder = await evaluate(
    `document.querySelector('[data-testid^="order-row-"]')?.getAttribute('data-testid')?.replace('order-row-','') ?? ''`
  );
  check('the orders list offers an order to open', firstOrder.length > 0, firstOrder || 'none listed');

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
  const firstProduct = await evaluate(
    `document.querySelector('[data-testid^="product-row-"]')?.getAttribute('data-testid')?.replace('product-row-','') ?? ''`
  );
  check('the products list offers a product to open', firstProduct.length > 0, firstProduct || 'none listed');

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
  for (let i = 0; i < 30; i += 1) {
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
  const realErrors = consoleErrors.filter((line) => !/favicon|fonts\.googleapis/.test(line));
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
} finally {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  console.log(`Screenshots in ${SHOTS}/`);
  ws.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}
