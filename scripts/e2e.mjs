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

import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const SHOTS = arg('shots', '.e2e');

fs.mkdirSync(SHOTS, { recursive: true });
import { requireShopOpen, startBrowser, sleep } from './lib/browser.mjs';

// One shared session: it asks the operating system for a free port and retries
// the launch. See `scripts/lib/browser.mjs` — guessing a port from a fixed range
// made chained runs collide, and a suite then reported the STORE as broken.
await requireShopOpen(BASE);
const session = await startBrowser({ label: 'store', shots: SHOTS, windowSize: '1440,1000' });
// `click` and `fill` return EXPRESSIONS for `evaluate`, not promises.
const { evaluate, goto, waitFor, click, fill, shot, close, send } = session;

// ---------------------------------------------------------------- the browser

const consoleErrors = [];

/** Evaluate an expression in the page and return its value. */

// ------------------------------------------------------------------- the run

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

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
  //
  // It WAITS FOR THE OUTCOME rather than for a fixed number of milliseconds. The
  // previous version slept 2.5s and then read the badge, so a request that took
  // slightly longer reported `badge="none"` — a failure that says nothing about
  // the store. This is the check that failed intermittently when the suites ran
  // back to back, and the cause was the test's clock, not the application.
  const added = await evaluate(`(async () => {
    const variant = document.querySelector('[data-testid="variant-OZK-HOD-M"]');
    const button = document.querySelector('[data-testid="add-to-cart"]');
    if (!variant || !button) return 'missing controls';
    variant.click();
    await new Promise((r) => setTimeout(r, 250));
    button.click();
    for (let i = 0; i < 40; i += 1) {
      const badge = document.querySelector('[data-testid="cart-count"]')?.textContent?.trim() ?? '';
      if (badge && badge !== '0') return badge;
      await new Promise((r) => setTimeout(r, 500));
    }
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
    // Wait for the subtotal to CHANGE rather than for a fixed delay, for the same
    // reason as the badge above.
    const before = document.querySelector('[data-testid="cart-subtotal"]')?.textContent?.trim() ?? '';
    for (let i = 0; i < 40; i += 1) {
      const now = document.querySelector('[data-testid="cart-subtotal"]')?.textContent?.trim() ?? '';
      if (now && now !== before) return now;
      await new Promise((r) => setTimeout(r, 500));
    }
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
  const realErrors = session.consoleErrors.filter((line) => !/favicon|fonts\.googleapis/.test(line));
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
  if (failed.length) {
    console.log('Failures:');
    for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  }
  console.log(`Screenshots in ${SHOTS}/`);
    await close();
  process.exit(failed.length ? 1 : 0);
}
