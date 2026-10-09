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
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/e2e-seo-admin.mjs \
 *     [--url https://shop.ozikoro.com] [--shots .e2e-seo]
 */

import fs from 'node:fs';
import path from 'node:path';

const index = process.argv.indexOf('--url');
const BASE = (index === -1 ? 'https://shop.ozikoro.com' : process.argv[index + 1]).replace(/\/+$/, '');
const shotsIndex = process.argv.indexOf('--shots');
const SHOTS = shotsIndex === -1 ? '.e2e-seo' : process.argv[shotsIndex + 1];



fs.mkdirSync(SHOTS, { recursive: true });
import { createHash, randomBytes } from 'node:crypto';

import { startBrowser, sleep } from './lib/browser.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const CF_TOKEN = process.env['CLOUDFLARE_API_TOKEN'];
const CF_ACCOUNT = process.env['CLOUDFLARE_ACCOUNT_ID'];
const DATABASE = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

let databaseId = null;
async function query(sql) {
  const response = await fetch(`${API}/accounts/${CF_ACCOUNT}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(`query failed: ${JSON.stringify(body?.errors ?? response.status)}`);
  return body.result ?? [];
}

const STAMP = Date.now().toString(36).slice(-6);
const STAFF_ID = `cus_seo_${STAMP}`;
const STAFF_TOKEN = randomBytes(32).toString('base64url');
const STAFF_SESSION = createHash('sha256').update(STAFF_TOKEN, 'utf8').digest('hex');

// One shared session: it asks the operating system for a free port and retries
// the launch. See `scripts/lib/browser.mjs` — guessing a port from a fixed range
// made chained runs collide, and a suite then reported the STORE as broken.
const session = await startBrowser({ label: 'seoadmin', shots: SHOTS, windowSize: '1440,1100' });
// `click` and `fill` return EXPRESSIONS for `evaluate`, not promises.
const { evaluate, goto, waitFor, click, fill, shot, close, send } = session;
// The suite's own name for the same thing.
const setField = fill;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}


// A code that is obviously a test, so a real one is never confused for it.
const TEST_CODE = `e2e-google-${Date.now().toString(36)}`;

try {
  // 1. A staff session, MINTED rather than signed in for.
  //
  // This suite is about the SEO screen. Signing in through the form made it
  // depend on the login, and a flaky sign-in then reported an SEO failure — it
  // happened twice. `createSession` stores only `sha256(token)`, so writing the
  // row and setting the same HttpOnly cookie the app sets is equivalent, and it
  // cannot fail for an unrelated reason.
  if (!CF_TOKEN || !CF_ACCOUNT) {
    console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
    process.exit(2);
  }
  const databases = await (await fetch(`${API}/accounts/${CF_ACCOUNT}/d1/database`, {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  })).json();
  databaseId = (databases?.result ?? []).find((entry) => entry.name === DATABASE)?.uuid;
  if (!databaseId) throw new Error(`No D1 database named "${DATABASE}".`);

  await query(
    `INSERT INTO customers (id, email, name, role) VALUES ('${STAFF_ID}', 'seo-staff-${STAMP}@example.com', 'SEO Probe', 'super_admin')`
  );
  await query(
    `INSERT INTO sessions (id, customer_id, role, expires_at, user_agent, ip_hash)
     VALUES ('${STAFF_SESSION}', '${STAFF_ID}', 'super_admin', datetime('now', '+1 day'), 'seo-probe', 'seo-probe')`
  );
  await session.setCookie('ozikoro_store_session', STAFF_TOKEN, { domain: new URL(BASE).hostname });
  check('a staff session is in place', true, 'minted directly');

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

  //
  // The confirmation is a transient note at the top of the page and it is worth
  // waiting a little for, but it is NOT the proof — the check below reads the
  // live head, which is. A missed toast must not fail a save that worked, so this
  // reports what the page said either way and lets the head decide.
  let saved = false;
  let lastText = '';
  for (let i = 0; i < 60 && !saved; i += 1) {
    await sleep(400);
    lastText = await evaluate('document.body.innerText');
    saved = /Saved\./.test(lastText ?? '');
  }
  check(
    'the screen reports the save',
    saved === true,
    saved ? '' : `no confirmation after 24s; page said: ${(lastText ?? '').replace(/\s+/g, ' ').slice(0, 90)}`
  );
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
  try {
    if (databaseId) {
      await query(`DELETE FROM sessions WHERE id = '${STAFF_SESSION}'`);
      await query(`DELETE FROM customers WHERE id = '${STAFF_ID}'`);
    }
  } catch (error) {
    console.error('cleanup failed:', error instanceof Error ? error.message : error);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  console.log(`Screenshots in ${SHOTS}/`);
    await close();
  process.exit(failed.length ? 1 : 0);
}
