#!/usr/bin/env node
/**
 * End-to-end check of the SEO settings screen.
 *
 * The screen is the point of the feature: a verification code arrives by email
 * and has to be pasted in without a deploy. So this test does exactly that —
 * signs in, opens the screen, types a code, saves, and then READS THE LIVE HEAD
 * to confirm the tag appeared. A test that only checked the form submitted would
 * pass while the tag never reached a page.
 *
 * Usage:
 *   E2E_EMAIL=… E2E_PASSWORD=… node scripts/e2e-seo-admin.mjs \
 *     [--url https://shop.ozikoro.com] [--shots .e2e-seo]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const index = process.argv.indexOf('--url');
const BASE = (index === -1 ? 'https://shop.ozikoro.com' : process.argv[index + 1]).replace(/\/+$/, '');
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex === -1 ? '.e2e-seo' : process.argv[shotsIndex + 1];

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

const port = 9980 + Math.floor(Math.random() * 15);
const chrome = spawn(
  CHROME,
  [
    '--headless=old',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=/tmp/cdp-seoadmin-${port}`,
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

/** Set a React-controlled input's value the way typing would. */
const setField = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

// A code that is obviously a test, so a real one is never confused for it.
const TEST_CODE = `e2e-google-${Date.now().toString(36)}`;

await send('Page.enable');
await send('Runtime.enable');

try {
  // 1. Sign in.
  await goto(`${BASE}/account`);
  await evaluate(setField('[data-testid="account-email"]', EMAIL));
  await evaluate(setField('[data-testid="account-password"]', PASSWORD));
  await evaluate("document.querySelector('[data-testid=\"account-submit\"]').click(); true");
  let signedIn = false;
  for (let i = 0; i < 40 && !signedIn; i += 1) {
    await sleep(500);
    signedIn = (await evaluate("!!document.querySelector('[data-testid=\"sign-out\"]')")) === true;
  }
  check('signed in', signedIn === true);

  // 2. The SEO screen is reachable and reachable from the nav.
  await goto(`${BASE}/admin/seo`);
  const hasNav = await evaluate("!!document.querySelector('[data-testid=\"admin-nav-seo\"]')");
  check('SEO is in the admin navigation', hasNav === true);

  const fieldCount = await evaluate("document.querySelectorAll('[data-testid^=\"seo-\"]').length");
  check('the SEO screen renders its settings', fieldCount > 10, `${fieldCount} controls`);

  for (const [label, selector] of [
    ['Google', '[data-testid="seo-verify-google"]'],
    ['Yandex', '[data-testid="seo-verify-yandex"]'],
    ['Bing', '[data-testid="seo-verify-bing"]'],
    ['a custom engine name', '[data-testid="seo-verify-other_name"]'],
    ['a custom engine value', '[data-testid="seo-verify-other_value"]'],
  ]) {
    const present = await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
    check(`there is a field for ${label}`, present === true);
  }

  const sitemapLink = await evaluate("!!document.querySelector('[data-testid=\"seo-sitemap-link\"]')");
  const robotsLink = await evaluate("!!document.querySelector('[data-testid=\"seo-robots-link\"]')");
  check('the screen links to the sitemap', sitemapLink === true);
  check('the screen links to robots.txt', robotsLink === true);
  await shot('01-seo-screen');

  // 3. Change the Google code and save.
  const typed = await evaluate(setField('[data-testid="seo-verify-google"]', TEST_CODE));
  check('the Google field accepts typing', typed === true);
  await evaluate("document.querySelector('[data-testid=\"seo-save\"]').click(); true");

  let saved = false;
  for (let i = 0; i < 30 && !saved; i += 1) {
    await sleep(400);
    const text = await evaluate("document.body.innerText");
    saved = /Saved\./.test(text ?? '');
  }
  check('the screen reports the save', saved === true, saved ? '' : 'no confirmation seen');
  await shot('02-seo-saved');

  // 4. The tag is now in the live head — the check that matters.
  let liveTag = null;
  for (let i = 0; i < 20 && !liveTag; i += 1) {
    await sleep(1000);
    const html = await (await fetch(`${BASE}/`)).text();
    liveTag = new RegExp(`<meta name="google-site-verification" content="${TEST_CODE}"`).test(html)
      ? TEST_CODE
      : null;
  }
  check('the saved code reached the live page head without a deploy', liveTag === TEST_CODE, liveTag ?? 'not found');

  // 5. It survives a reload of the screen, so it was stored and not only held in
  //    the browser.
  await goto(`${BASE}/admin/seo`);
  const reloaded = await evaluate(
    `document.querySelector('[data-testid="seo-verify-google"]')?.value ?? ''`
  );
  check('the screen shows the stored value after a reload', reloaded === TEST_CODE, String(reloaded).slice(0, 30));

  // 6. Clearing it removes the tag rather than publishing an empty one.
  await evaluate(setField('[data-testid="seo-verify-google"]', ''));
  await evaluate("document.querySelector('[data-testid=\"seo-save\"]').click(); true");
  await sleep(3000);

  let cleared = false;
  for (let i = 0; i < 20 && !cleared; i += 1) {
    await sleep(1000);
    const html = await (await fetch(`${BASE}/`)).text();
    cleared = !html.includes(TEST_CODE);
  }
  check('clearing the field removes the tag', cleared === true);
  const emptyTag = await (await fetch(`${BASE}/`)).text();
  check(
    'no empty verification tag is published',
    !/<meta name="google-site-verification" content=""/.test(emptyTag)
  );
} finally {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  console.log(`Screenshots in ${SHOTS}/`);
  ws.close();
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
}
