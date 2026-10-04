#!/usr/bin/env node
/**
 * The admin's write paths, driven as a person would.
 *
 * WHY THIS EXISTS
 *
 * Nothing had ever created a product or a variant through the admin. The
 * catalogue was seeded by SQL, so every write path in the catalogue admin was
 * unexercised: create, edit, add a variant, change stock, archive. Those are the
 * screens an owner uses daily, and each one is a form whose failure is silent —
 * the page says Saved, and the storefront disagrees.
 *
 * The test therefore does not trust the confirmation. It:
 *
 *   1. Creates a product and checks it appears on the STOREFRONT.
 *   2. Edits its price and checks the STOREFRONT shows the new price.
 *   3. Adds a variant and checks the storefront offers it.
 *   4. Sets a variant's stock to zero and checks the storefront says so.
 *   5. Archives the product and checks it disappears from the storefront.
 *   6. Leaves nothing behind: the product is archived, and the run is repeatable.
 *
 * Cleanup matters as much as the assertions. A test that leaves a "...-test"
 * product in a live shop is a test that will frighten someone at 2am.
 *
 * Usage:
 *   E2E_EMAIL=… E2E_PASSWORD=… node scripts/e2e-admin-catalog.mjs [--url …] [--shots …]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const index = process.argv.indexOf('--url');
const BASE = (index === -1 ? 'https://shop.ozikoro.com' : process.argv[index + 1]).replace(/\/+$/, '');
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex === -1 ? '.e2e-admin-catalog' : process.argv[shotsIndex + 1];

const EMAIL = process.env['E2E_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';
if (!EMAIL || !PASSWORD) {
  console.error('E2E_EMAIL and E2E_PASSWORD must be set.');
  process.exit(2);
}

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// Unique per run, so a previous failed run cannot make this one pass.
const STAMP = Date.now().toString(36).slice(-6);
const SLUG = `e2e-probe-${STAMP}`;
const TITLE = `E2E Probe ${STAMP}`;
const PRICE_NAIRA = 1234;
const EDITED_PRICE_NAIRA = 4321;

const port = 9860 + Math.floor(Math.random() * 30);
const chrome = spawn(
  CHROME,
  [
    '--headless=old',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/cdp-catalog-${port}`,
    '--window-size=1440,1200',
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

async function goto(url, settle = 1500) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (await evaluate("document.readyState === 'complete'")) break;
  }
  await sleep(settle);
}

/** Wait until a selector exists, so client-side loads are not raced. */
async function waitFor(selector, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await sleep(400);
  }
  return false;
}

async function shot(name) {
  const response = await send('Page.captureScreenshot', { format: 'png' });
  if (response?.result?.data) {
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(response.result.data, 'base64'));
  }
}

/** Fill a controlled field the way typing does, so React sees the change. */
const fill = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

/** Click and report whether anything was there to click. */
const click = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.click();
  return true;
})()`;

/** The storefront's view of a product, asked of the server rather than the browser. */
async function storefront(pathname) {
  const response = await fetch(`${BASE}${pathname}`);
  const html = await response.text();
  const body = (html.match(/<main[\s\S]*?<\/main>/) ?? [''])[0];
  return { status: response.status, html, text: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

await send('Page.enable');
await send('Runtime.enable');

let createdProduct = false;

try {
  // ---------------------------------------------------------------- sign in
  await goto(`${BASE}/account`);
  await waitFor('[data-testid="account-email"]');
  await evaluate(fill('[data-testid="account-email"]', EMAIL));
  await evaluate(fill('[data-testid="account-password"]', PASSWORD));
  await evaluate(click('[data-testid="account-submit"]'));
  let signedIn = false;
  for (let i = 0; i < 50 && !signedIn; i += 1) {
    await sleep(500);
    signedIn = (await evaluate(`!!document.querySelector('[data-testid="sign-out"]')`)) === true;
  }
  check('signed in as staff', signedIn === true);
  if (!signedIn) throw new Error('cannot continue without a signed-in staff session');

  // --------------------------------------------------- sweep earlier debris
  //
  // A run that is interrupted — a timeout, a killed shell — leaves its probe
  // product behind, because the cleanup in `finally` never executes. Two such
  // products accumulated in the live shop. Archiving every `e2e-probe-*` product
  // at the start makes each run repair the last one, so a live shop cannot
  // slowly fill with test products no matter how a previous run ended.
  let swept = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await goto(`${BASE}/admin/products`);
    if (!(await waitFor('[data-testid="products-search"]', 30))) break;
    const leftover = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-testid^="product-row-"]')];
      const probe = rows.find((row) => (row.getAttribute('data-testid') ?? '').includes('e2e-probe-'));
      return probe ? probe.getAttribute('data-testid').replace('product-row-', '') : '';
    })()`);
    if (!leftover) break;
    await goto(`${BASE}/admin/products/${leftover}`);
    if (!(await waitFor('[data-testid="product-archive"]', 30))) break;
    await evaluate(click('[data-testid="product-archive"]'));
    await sleep(1000);
    await evaluate(click('[data-testid="product-archive"]'));
    await sleep(2500);
    swept += 1;
  }
  if (swept > 0) console.log(`      swept ${swept} probe product(s) left by an earlier interrupted run`);

  // ------------------------------------------------------- 1. create a product
  await goto(`${BASE}/admin/products`);
  await waitFor('[data-testid="products-new"]');
  check('the products list offers a new product', await evaluate(`!!document.querySelector('[data-testid="products-new"]')`));
  await evaluate(click('[data-testid="products-new"]'));
  await waitFor('[data-testid="product-form"]', 40);

  const formReady = await waitFor('[data-testid="product-title"]', 40);
  check('the new-product form opens', formReady === true);
  if (!formReady) throw new Error('no product form');

  await evaluate(fill('[data-testid="product-title"]', TITLE));
  await evaluate(fill('[data-testid="product-slug"]', SLUG));
  // The category is REQUIRED and is FREE TEXT, not a select. Leaving it empty
  // makes the server refuse with "A product needs a category." — which is
  // correct behaviour and looks exactly like a broken form if the field is
  // missed. The value matches an existing collection so the storefront links work.
  await evaluate(fill('[data-testid="product-category"]', 'Prints & Posters'));
  // The price field is in MAJOR units (naira), not kobo.
  await evaluate(fill('[data-testid="product-price"]', PRICE_NAIRA));
  await evaluate(fill('[data-testid="product-description"]', 'A product created by the end-to-end suite. It is archived at the end of the run.'));
  // A new product starts as a DRAFT, so that a half-written one is never in the
  // shop. Publishing is a deliberate second act, and the test performs it rather
  // than assuming the default — the first version of this test expected a draft
  // to be on the storefront and read the correct 404 as a failure.
  await evaluate(fill('[data-testid="product-status"]', 'active'));
  await shot('01-new-product');

  // Every required field is checked BEFORE saving, so a refusal is reported as a
  // missing-field mistake in the test rather than as a broken store.
  const beforeSave = await evaluate(`JSON.stringify({
    title: document.querySelector('[data-testid="product-title"]')?.value ?? '',
    slug: document.querySelector('[data-testid="product-slug"]')?.value ?? '',
    category: document.querySelector('[data-testid="product-category"]')?.value ?? '',
    price: document.querySelector('[data-testid="product-price"]')?.value ?? '',
    status: document.querySelector('[data-testid="product-status"]')?.value ?? '',
  })`);
  const fields = JSON.parse(beforeSave);
  check(
    'the test filled every required field before saving',
    Boolean(fields.title && fields.slug && fields.category && fields.price),
    beforeSave
  );
  check(
    'the test published the product rather than leaving it a draft',
    fields.status === 'active',
    `status "${fields.status}"`
  );

  await evaluate(click('[data-testid="product-save"]'));
  // Success on a CREATE is a NAVIGATION, not a note. The component navigates to
  // the new product's own page, so `product-ok` is never rendered in the state
  // the test is watching — and waiting for it reported a working save as a
  // failure. On a save of an existing product the note does appear, so both
  // outcomes are accepted and the refusal is still surfaced.
  let saved = false;
  let refusal = '';
  for (let i = 0; i < 40 && !saved; i += 1) {
    await sleep(500);
    const url = await evaluate('location.pathname');
    if (url === `/admin/products/${SLUG}`) {
      saved = true;
      break;
    }
    refusal = await evaluate(
      `document.querySelector('[data-testid="product-error"]')?.textContent ?? ''`
    );
    if (refusal) break;
  }
  check(
    'saving the new product is confirmed',
    saved === true,
    saved ? 'the editor moved to the new product' : refusal ? `the server refused: ${refusal}` : 'no confirmation appeared'
  );

  // The confirmation is not the proof; the storefront is.
  const afterCreate = await storefront(`/products/${SLUG}`);
  createdProduct = afterCreate.status === 200;
  check(
    'the new product appears on the storefront',
    createdProduct,
    `status ${afterCreate.status}`
  );
  // The storefront formats money with a thousands separator, and only shows
  // decimals when there are any: ₦1,234 and ₦1,234.50. Asserting on the raw
  // integer found nothing while the page was correct.
  check(
    'the storefront shows the price that was entered',
    afterCreate.text.includes(`₦${PRICE_NAIRA.toLocaleString('en-NG')}`),
    afterCreate.text.slice(0, 90)
  );

  // --------------------------------------------------------- 2. edit the price
  if (createdProduct) {
    await goto(`${BASE}/admin/products/${SLUG}`);
    await waitFor('[data-testid="product-form"]', 40);
    await evaluate(fill('[data-testid="product-price"]', EDITED_PRICE_NAIRA));
    await evaluate(click('[data-testid="product-save"]'));
    await sleep(3500);

    const afterEdit = await storefront(`/products/${SLUG}`);
    const editedText = `₦${EDITED_PRICE_NAIRA.toLocaleString('en-NG')}`;
    const originalText = `₦${PRICE_NAIRA.toLocaleString('en-NG')}`;
    check(
      'an edited price reaches the storefront',
      afterEdit.text.includes(editedText),
      afterEdit.text.includes(editedText) ? `showing ${editedText}` : afterEdit.text.slice(0, 90)
    );
    check(
      'the old price is gone from the storefront',
      !afterEdit.text.includes(originalText),
      afterEdit.text.includes(originalText) ? `still showing ${originalText}` : ''
    );

    // ------------------------------------------------ 3. add a variant
    const variantForm = await waitFor('[data-testid="variant-new-form"]', 40);
    check('the product editor offers a new variant form', variantForm === true);
    if (variantForm) {
      await evaluate(fill('[data-testid="variant-new-sku"]', `E2E-${STAMP}-ONE`));
      await evaluate(fill('[data-testid="variant-new-title"]', 'Probe Size'));
      await evaluate(fill('[data-testid="variant-new-price"]', '5550'));
      await evaluate(fill('[data-testid="variant-new-stock"]', 7));
      await evaluate(click('[data-testid="variant-new-submit"]'));
      await sleep(4000);

      const withVariant = await storefront(`/products/${SLUG}`);
      check(
        'the new variant reaches the storefront',
        withVariant.text.includes('Probe Size'),
        withVariant.text.includes('Probe Size') ? 'offered' : withVariant.text.slice(0, 100)
      );

      // ------------------------------------ 4. zero stock on that variant
      //
      // The per-variant controls are keyed on the variant's ID, not its SKU, so
      // the id is read from the DOM rather than guessed from the SKU the test
      // chose.
      await goto(`${BASE}/admin/products/${SLUG}`);
      await waitFor('[data-testid^="variant-stock-"]', 40);
      const variantStockId = await evaluate(
        `document.querySelector('[data-testid^="variant-stock-"]')?.getAttribute('data-testid')?.replace('variant-stock-','') ?? ''`
      );
      check('a variant stock field is present to edit', variantStockId.length > 0, variantStockId || 'none found');

      if (variantStockId) {
        await evaluate(fill(`[data-testid="variant-stock-${variantStockId}"]`, 0));
        await evaluate(click(`[data-testid="variant-save-${variantStockId}"]`));
        await sleep(4000);
        const soldOut = await storefront(`/products/${SLUG}`);
        check(
          'setting a variant to zero stock is reflected on the storefront',
          /sold out|out of stock|notify/i.test(soldOut.text),
          soldOut.text.slice(0, 130)
        );
      }
    }

    // ------------------------------------------------- 5. archive the product
    await goto(`${BASE}/admin/products/${SLUG}`);
    await waitFor('[data-testid="product-archive"]', 40);
    await evaluate(click('[data-testid="product-archive"]'));
    // An archive may ask for confirmation; accept whatever dialog appears.
    await sleep(1500);
    await evaluate(`(() => { const b = document.querySelector('[data-testid="product-archive"]'); if (b) b.click(); return true; })()`);
    await sleep(4000);

    const archived = await storefront(`/products/${SLUG}`);
    check(
      'an archived product leaves the storefront',
      archived.status === 404,
      `status ${archived.status}`
    );
    await shot('02-after-archive');
  }
} finally {
  // ------------------------------------------------------------------ cleanup
  //
  // Archiving is the assertion AND the cleanup. If the run failed before that
  // point, archive it here so a live shop is never left holding a test product.
  try {
    if (createdProduct) {
      await goto(`${BASE}/admin/products/${SLUG}`);
      await waitFor('[data-testid="product-archive"]', 30);
      await evaluate(click('[data-testid="product-archive"]'));
      await sleep(1200);
      await evaluate(`(() => { const b = document.querySelector('[data-testid="product-archive"]'); if (b) b.click(); return true; })()`);
      await sleep(3000);
      const finalState = await fetch(`${BASE}/products/${SLUG}`);
      console.log(`\n      cleanup: /products/${SLUG} now answers ${finalState.status}`);
    }
  } catch (error) {
    console.error('cleanup failed:', error instanceof Error ? error.message : error);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  console.log(`Screenshots in ${SHOTS}/`);
  ws.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}
