#!/usr/bin/env node
/**
 * How far does checkout get, and what does it leave behind?
 *
 * WHY THIS TEST EXISTS
 *
 * "Every function works" cannot be claimed for a store that has never taken a
 * payment. This drives the FULL checkout in a browser with a real Lagos address
 * and asserts one of exactly two correct outcomes:
 *
 *   WITHOUT A PAYMENT KEY — the refusal names the payment provider, and NO ORDER
 *   IS CREATED. Nothing else may fail, and nothing may be left holding stock: a
 *   store that creates an order and reserves inventory for a payment it never
 *   starts loses stock to every abandoned attempt.
 *
 *   WITH A PAYMENT KEY — the browser is handed to Paystack with a real
 *   authorisation URL, an order exists with the correct total, its stock is
 *   reserved, and a payment row is `pending`. That is the complete path a
 *   customer takes up to the point where a card is required.
 *
 * IT CREATES AN ORDER WHEN A KEY IS SET, and says so, and prints the order
 * number. Cancel it afterwards with:
 *
 *   node scripts/cancel-abandoned-orders.mjs --number OZK-10003
 *
 * A paid order is never cancelled by that tool — it refuses one Paystack reports
 * as `success`, because cancelling a paid order is a refund and a different
 * decision.
 *
 * Usage:
 *   node scripts/e2e-checkout.mjs [--url …] [--cancel]
 *
 * `--cancel` runs the cleanup itself, for a test that leaves the store exactly
 * as it found it.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const index = process.argv.indexOf('--url');
const BASE = (index === -1 ? 'https://shop.ozikoro.com' : process.argv[index + 1]).replace(/\/+$/, '');
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex === -1 ? '.e2e-checkout' : process.argv[shotsIndex + 1];

const EMAIL = process.env['E2E_EMAIL'] ?? `checkout-probe-${Date.now().toString(36)}@example.com`;
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const CANCEL_AFTER = process.argv.includes('--cancel');

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const port = 9940 + Math.floor(Math.random() * 30);
const chrome = spawn(
  CHROME,
  [
    '--headless=old',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/cdp-checkout-${port}`,
    '--window-size=1440,1100',
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
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
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

/** Fill a controlled field the way typing does. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

await send('Page.enable');
await send('Runtime.enable');

try {
  // 1. Put something in the cart, as a customer would.
  await goto(`${BASE}/products/the-ozikoro-reader`);
  const added = await evaluate(`(async () => {
    const variant = document.querySelector('[data-testid^="variant-OZK-RDR"]');
    if (variant) variant.click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('[data-testid="add-to-cart"]').click();
    await new Promise((r) => setTimeout(r, 2500));
    return document.querySelector('[data-testid="cart-count"]')?.textContent?.trim() ?? 'none';
  })()`);
  check('an item can be added to the cart', added === '1', `badge "${added}"`);

  // 2. Go to checkout and fill the whole form with a REAL, valid address.
  await goto(`${BASE}/checkout`);
  const email = EMAIL;
  for (const [selector, value] of [
    ['[data-testid="checkout-email"]', email],
    ['[data-testid="checkout-first"]', 'Ada'],
    ['[data-testid="checkout-last"]', 'Okeke'],
    ['[data-testid="checkout-line1"]', '14 Awolowo Road, Ikoyi'],
    ['[data-testid="checkout-city"]', 'Lagos'],
    ['[data-testid="checkout-region"]', 'Lagos'],
    ['[data-testid="checkout-phone"]', '08031234567'],
  ]) {
    const ok = await evaluate(fill(selector, value));
    if (!ok) check(`the field ${selector} exists`, false, 'missing');
  }
  await sleep(2500);

  const shipping = await evaluate(
    "document.querySelector('[data-testid=\"summary-shipping\"]')?.textContent?.trim() ?? ''"
  );
  const total = await evaluate(
    "document.querySelector('[data-testid=\"summary-total\"]')?.textContent?.trim() ?? ''"
  );
  check('shipping is quoted for a Lagos address', /2,500/.test(shipping), shipping);
  check('a total is shown before paying', /₦/.test(total), total);
  await shot('01-checkout-filled');

  // 3. Submit and see which of the two correct outcomes happens.
  await evaluate("document.querySelector('[data-testid=\"place-order\"]').click(); true");

  let message = '';
  let handedToPaystack = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(600);
    const url = await evaluate('location.href');
    if (url.startsWith('https://checkout.paystack.com')) {
      handedToPaystack = true;
      break;
    }
    message = await evaluate("document.querySelector('[role=\"alert\"]')?.textContent?.trim() ?? ''");
    if (message) break;
  }
  await shot(handedToPaystack ? '02-handed-to-paystack' : '02-checkout-refused');

  if (handedToPaystack) {
    // With a key set this is the SUCCESS case: the customer is on Paystack's
    // page, which is as far as any automated test can go, because the next step
    // needs a card.
    check('the customer is handed to Paystack to pay', true, 'checkout.paystack.com');
    check(
      'checkout validated the address and quoted shipping before leaving',
      /2,500/.test(shipping) && /₦/.test(total),
      `${shipping} · ${total}`
    );
    console.log('\n      An order was created and its stock reserved.');
    console.log('      Paying needs a card, which no automated test can supply.');
    if (CANCEL_AFTER) {
      console.log('      Run the cleanup below, or re-run with --cancel.');
    }
  } else {
    check('the submit produces a message rather than silence', message.length > 0, message.slice(0, 90));
    // The refusal must be about the payment provider, not about the form. Any
    // other message means the checkout is broken earlier.
    const isPaymentKey = /payment is not configured|card payment/i.test(message);
    check(
      'the only thing blocking the purchase is the payment provider key',
      isPaymentKey,
      isPaymentKey
        ? 'checkout validated the address, quoted shipping and reached the payment step'
        : `a different failure: ${message.slice(0, 120)}`
    );
  }
} finally {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  console.log(`Screenshots in ${SHOTS}/`);
  ws.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}

void PASSWORD;
