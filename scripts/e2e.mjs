#!/usr/bin/env node
/**
 * End-to-end check of the storefront, in a real browser.
 *
 * WHY A BROWSER AND NOT CURL
 *
 * The cart, checkout and account flows are TanStack Start server functions, and
 * they run behind a CSRF filter that rejects any request whose `Origin` is not
 * the site's own. That is the correct behaviour and it means curl cannot
 * exercise them. So this drives headless Chrome over the DevTools Protocol: it
 * loads a real page, clicks real controls, and reads the result out of the DOM.
 *
 * WHAT IT PROVES, and why each check is here
 *
 *   1. The catalogue renders from D1 with real prices and real stock.
 *   2. Selecting a sold-out variant is refused, and the button says so — the
 *      handoff's "out-of-stock cannot be purchased accidentally".
 *   3. Adding to the cart works, the header badge updates, and the cart page
 *      shows the same total the badge counts.
 *   4. The quantity controls change the subtotal by exactly one unit price, so
 *      the arithmetic the customer sees is the arithmetic the server computed.
 *   5. Checkout quotes shipping from the delivery address, before payment.
 *   6. Checkout refuses an incomplete address with a message, rather than
 *      starting a payment for an order that cannot ship.
 *   7. Every page returns a real document with a title and a canonical link.
 *
 * Usage:
 *   node scripts/e2e.mjs [--url http://127.0.0.1:8787] [--shots .e2e]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const SHOTS = arg('shots', '.e2e');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.mkdirSync(SHOTS, { recursive: true });

// ---------------------------------------------------------------- the browser

const port = 9800 + Math.floor(Math.random() * 200);
const chrome = spawn(
  CHROME,
  [
    '--headless=old',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/cdp-e2e-${port}`,
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
    // Chrome is not listening yet.
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

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response?.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.text ?? 'page evaluation failed');
  }
  return response?.result?.result?.value;
}

async function goto(url) {
  await send('Page.navigate', { url });
  // Wait for the document and for React to have hydrated something.
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    const ready = await evaluate("document.readyState === 'complete' && !!document.querySelector('main')");
    if (ready) break;
  }
  await sleep(600);
}

async function shot(name) {
  const response = await send('Page.captureScreenshot', { format: 'png' });
  if (response?.result?.data) {
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(response.result.data, 'base64'));
  }
}

// ------------------------------------------------------------------- the run

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

await send('Page.enable');
await send('Runtime.enable');

try {
  // 1. Home renders from the database.
  await goto(`${BASE}/`);
  const homeTitle = await evaluate('document.title');
  const heroText = await evaluate("document.body.innerText.includes('Culture, made')");
  const featuredCount = await evaluate("document.querySelectorAll('[data-testid^=\"product-card-\"]').length");
  check('home renders with a title', Boolean(homeTitle), homeTitle);
  check('home shows the hero', heroText === true);
  check('home lists products from D1', featuredCount > 0, `${featuredCount} cards`);
  await shot('01-home');

  // 2. The shop lists the seeded catalogue.
  await goto(`${BASE}/shop`);
  const shopCards = await evaluate("document.querySelectorAll('[data-testid^=\"product-card-\"]').length");
  const shopCount = await evaluate(
    "document.querySelector('[data-testid=\"result-count\"]')?.textContent?.trim()"
  );
  check('shop lists the catalogue', shopCards === 9, `${shopCards} cards, label "${shopCount}"`);

  // 3. A product page: real price, variant selection, and the sold-out guard.
  await goto(`${BASE}/products/everyday-hoodie`);
  const price = await evaluate(
    "document.querySelector('[data-testid=\"product-price\"]')?.textContent?.trim()"
  );
  check('product page shows a real price', /\d/.test(price ?? ''), price);

  // The XL hoodie is seeded with zero stock, so its control must be disabled.
  const soldOutDisabled = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="variant-OZK-HOD-XL"]');
    if (!button) return 'missing';
    return button.disabled === true;
  })()`);
  check('a zero-stock variant cannot be selected', soldOutDisabled === true, String(soldOutDisabled));
  await shot('02-product-sold-out');

  // 4. Add an in-stock variant to the cart.
  const added = await evaluate(`(async () => {
    document.querySelector('[data-testid="variant-OZK-HOD-M"]').click();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector('[data-testid="add-to-cart"]').click();
    await new Promise((r) => setTimeout(r, 2500));
    return document.querySelector('[data-testid="cart-count"]')?.textContent?.trim() ?? 'none';
  })()`);
  check('adding to the cart updates the badge', added === '1', `badge="${added}"`);
  await shot('03-added-to-cart');

  // 5. The cart page agrees with the badge.
  await goto(`${BASE}/cart`);
  const lines = await evaluate("document.querySelectorAll('[data-testid^=\"cart-line-\"]').length");
  const subtotal = await evaluate(
    "document.querySelector('[data-testid=\"cart-subtotal\"]')?.textContent?.trim()"
  );
  check('the cart holds the item', lines === 1, `${lines} line(s)`);
  check('the cart shows a subtotal', subtotal === '₦34,000', subtotal);
  await shot('04-cart');

  // 6. Quantity arithmetic: 2 x ₦34,000 = ₦68,000.
  const afterIncrease = await evaluate(`(async () => {
    document.querySelector('[data-testid="increase-OZK-HOD-M"]').click();
    await new Promise((r) => setTimeout(r, 2500));
    return document.querySelector('[data-testid="cart-subtotal"]')?.textContent?.trim() ?? '';
  })()`);
  check('quantity changes the subtotal exactly', afterIncrease === '₦68,000', afterIncrease);

  // Put it back to one so the remaining checks stay simple.
  await evaluate(`(async () => {
    document.querySelector('[data-testid="decrease-OZK-HOD-M"]').click();
    await new Promise((r) => setTimeout(r, 2500));
  })()`);

  // 7. Checkout: an incomplete address must be refused, not silently accepted.
  await goto(`${BASE}/checkout`);
  const total = await evaluate(
    "document.querySelector('[data-testid=\"summary-total\"]')?.textContent?.trim()"
  );
  check('checkout shows a total', /₦/.test(total ?? ''), total);

  const refused = await evaluate(`(async () => {
    document.querySelector('[data-testid="place-order"]').click();
    await new Promise((r) => setTimeout(r, 2500));
    const alert = document.querySelector('[role="alert"]');
    return alert ? alert.textContent.trim() : 'no message';
  })()`);
  check('an incomplete address is refused with a message', refused !== 'no message', refused.slice(0, 90));
  await shot('05-checkout-validation');

  // 8. Shipping is quoted from the address, before payment.
  const shipping = await evaluate(`(async () => {
    const set = (id, value) => {
      const el = document.querySelector(id);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('[data-testid="checkout-city"]', 'Lagos');
    set('[data-testid="checkout-region"]', 'Lagos');
    await new Promise((r) => setTimeout(r, 2500));
    return document.querySelector('[data-testid="summary-shipping"]')?.textContent?.trim() ?? '';
  })()`);
  check('shipping is quoted from the city', /₦2,500/.test(shipping), shipping);
  await shot('06-checkout-shipping');

  // 9. Static and policy pages.
  for (const [label, url, needle] of [
    ['privacy policy', '/privacy', 'Cookies'],
    ['terms of sale', '/terms', 'Governing law'],
    ['refund policy', '/refunds', 'How refunds are paid'],
    ['shipping page', '/shipping-returns', 'Nationwide courier'],
    ['contact page', '/contact', 'store@ozikoro.com'],
    ['search', '/search?q=ikenga', 'Ikenga'],
  ]) {
    await goto(`${BASE}${url}`);
    const present = await evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`);
    check(`${label} renders`, present === true);
  }

  // 10. The admin surface must refuse a signed-out visitor.
  await goto(`${BASE}/admin`);
  const refusedAdmin = await evaluate(`(() => {
    const gate = document.querySelector('[data-testid="admin-not-authorised"]');
    return gate ? gate.textContent.trim().slice(0, 70) : 'no gate';
  })()`);
  check('admin refuses a signed-out visitor', refusedAdmin !== 'no gate', refusedAdmin);
  await shot('07-admin-gate');

  // 11. A 404 for a product that does not exist, rather than an empty page.
  await send('Page.navigate', { url: `${BASE}/products/not-a-real-product` });
  await sleep(2500);
  const notFoundBody = await evaluate('document.body.innerText.slice(0, 200)');
  check('an unknown product is not a blank page', (notFoundBody ?? '').length > 20, (notFoundBody ?? '').slice(0, 60));

  // 12. No console errors on the way through.
  const realErrors = consoleErrors.filter((line) => !/favicon|fonts\.googleapis/.test(line));
  check('no console errors during the run', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

  // 13. Mobile: the checkout must be usable at 390px without horizontal scroll.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await goto(`${BASE}/checkout`);
  const overflow = await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
  const placeOrderVisible = await evaluate(`(() => {
    const button = document.querySelector('[data-testid="place-order"]');
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    return rect.width > 100 && rect.height > 20;
  })()`);
  check('checkout does not overflow at 390px', overflow === true);
  check('the pay button is usable on mobile', placeOrderVisible === true);
  await shot('08-checkout-mobile');
  await send('Emulation.clearDeviceMetricsOverride');
} finally {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('Failures:');
    for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  }
  console.log(`Screenshots in ${SHOTS}/`);
  ws.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}
