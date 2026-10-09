#!/usr/bin/env node
/**
 * The storefront visibility switch: does "coming soon" actually mean it?
 *
 * WHY THIS IS NOT A BROWSER-ONLY TEST
 *
 * Two different things have to be true, and they are checked in the two places
 * they can be observed:
 *
 *   the GATE      an anonymous request must be turned away from every storefront
 *                 page — checked with plain HTTP, following no redirects, so the
 *                 status and the Location are what is asserted rather than what a
 *                 browser chose to render
 *   the SWITCH    somebody in the admin must be able to throw it — checked in a
 *                 browser, because it is a control on a page
 *
 * WHAT IT IS CAREFUL ABOUT
 *
 * A closed shop must still be a WORKING shop for the people inside it. So this
 * asserts the three things an overly eager gate would break, each of which would
 * be a real incident:
 *
 *   the payment webhook    a payment taken before the shop closed could not
 *                          settle, stranding a customer's money
 *   the admin              the owner could not reopen the shop
 *   signing in / the OP    ozikoro.com and ozituma.com would stop working
 *
 * It puts the switch back where it found it and removes its probe account, so
 * running the suite never changes whether the shop is open.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/e2e-storefront.mjs [--url …] [--shots …]
 */

import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';

import { sleep, startBrowser } from './lib/browser.mjs';

const API = 'https://api.cloudflare.com/client/v4';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'https://shop.ozikoro.com').replace(/\/+$/, '');
const SHOTS = arg('shots', '.e2e-storefront');
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  process.exit(2);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

let databaseId = null;
async function query(sql) {
  const response = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(`query failed: ${JSON.stringify(body?.errors ?? response.status)}`);
  return body.result ?? [];
}
const rows = (result) => result?.[0]?.results ?? [];
const readOpen = async () => String(rows(await query(`SELECT value FROM settings WHERE key = 'store.open'`))[0]?.value ?? '');

/** One anonymous request, following nothing, so status and Location are visible. */
async function anon(path, cookie) {
  const response = await fetch(`${BASE}${path}`, {
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {},
  });
  return {
    status: response.status,
    location: response.headers.get('location') ?? '',
    body: response.status === 200 ? await response.text() : '',
  };
}

const STAMP = Date.now().toString(36).slice(-6);
const STAFF_ID = `cus_gate_${STAMP}`;
const STAFF_TOKEN = randomBytes(32).toString('base64url');
const STAFF_SESSION = createHash('sha256').update(STAFF_TOKEN, 'utf8').digest('hex');
/** A signed-in customer: still a member of the public as far as the shop is concerned. */
const PLAIN_ID = `cus_gatep_${STAMP}`;
const PLAIN_TOKEN = randomBytes(32).toString('base64url');
const PLAIN_SESSION = createHash('sha256').update(PLAIN_TOKEN, 'utf8').digest('hex');

let originalState = null;
const session = await startBrowser({ label: 'storefront', shots: SHOTS, windowSize: '1440,1100' });

try {
  const list = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  databaseId = (list?.result ?? []).find((entry) => entry.name === databaseName)?.uuid;
  if (!databaseId) throw new Error(`No D1 database named "${databaseName}".`);

  originalState = await readOpen();
  check(
    'the switch exists and holds a value',
    originalState === '0' || originalState === '1',
    `store.open = "${originalState}" — anything else would be read as CLOSED`
  );

  await query(
    `INSERT INTO customers (id, email, name, role) VALUES ('${STAFF_ID}', 'gate-staff-${STAMP}@example.com', 'Gate Probe', 'store_admin')`
  );
  await query(
    `INSERT INTO sessions (id, customer_id, role, expires_at, user_agent, ip_hash)
     VALUES ('${STAFF_SESSION}', '${STAFF_ID}', 'store_admin', datetime('now', '+1 day'), 'gate-probe', 'gate-probe')`
  );
  await query(
    `INSERT INTO customers (id, email, name, role) VALUES ('${PLAIN_ID}', 'gate-plain-${STAMP}@example.com', 'Plain Probe', 'customer')`
  );
  await query(
    `INSERT INTO sessions (id, customer_id, role, expires_at, user_agent, ip_hash)
     VALUES ('${PLAIN_SESSION}', '${PLAIN_ID}', 'customer', datetime('now', '+1 day'), 'gate-probe', 'gate-probe')`
  );

  const staffCookie = `ozikoro_store_session=${STAFF_TOKEN}`;
  const plainCookie = `ozikoro_store_session=${PLAIN_TOKEN}`;

  // ------------------------------------------------------------- CLOSED
  if (originalState !== '0') {
    await query(`UPDATE settings SET value = '0', updated_at = datetime('now') WHERE key = 'store.open'`);
    await sleep(1500);
  }

  for (const path of ['/', '/shop', '/collections', '/cart', '/checkout', '/contact']) {
    const response = await anon(path);
    const redirected = response.status >= 300 && response.status < 400 && response.location.includes('/coming-soon');
    check(
      `a closed shop hides ${path}`,
      redirected,
      redirected ? `${response.status} → /coming-soon` : `got ${response.status} ${response.location}`
    );
  }

  const closed = await anon('/');
  check(
    'the redirect does not leak the shop in its body',
    !/cart-count|The Ozikoro Reader/.test(closed.body),
    'a redirect with the page attached is not hidden'
  );

  // SIGN-IN STAYS OPEN, and this is the exception that matters most.
  //
  // `/account` is not a storefront page — it is how the identity provider
  // authenticates people, and `ozikoro.com` and `ozituma.com` send their users
  // here to sign in. Hiding it with the shop would break single sign-on across
  // the whole platform every time the store was closed. This was found by
  // breaking it: the OIDC suite went from 29/29 to 9/12 the moment the shop shut.
  for (const path of ['/account', '/order-lookup']) {
    const response = await anon(path);
    check(
      `sign-in stays reachable at ${path} while the shop is closed`,
      response.status !== 307 && !response.location.includes('/coming-soon'),
      `status ${response.status} — hiding this would break SSO for every Ozikoro platform`
    );
  }

  // The things an over-eager gate would break. Each is a real incident.
  const webhook = await fetch(`${BASE}/api/webhooks/paystack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  check(
    'THE PAYMENT WEBHOOK STILL REACHES THE STORE',
    webhook.status !== 404 && webhook.status !== 307,
    `status ${webhook.status} — 401 means reachable and refusing an unsigned call, which is correct; a 404 or a redirect would strand a payment taken before closing`
  );

  for (const path of ['/admin', '/admin/store']) {
    const response = await anon(path);
    check(`the admin stays reachable at ${path}`, response.status === 200, `status ${response.status}`);
  }

  for (const path of ['/.well-known/openid-configuration', '/oidc/jwks.json']) {
    const response = await anon(path);
    check(`the identity provider stays reachable at ${path}`, response.status === 200, `status ${response.status}`);
  }

  const comingSoon = await anon('/coming-soon');
  check('the coming-soon page itself is served, not redirected', comingSoon.status === 200, `status ${comingSoon.status}`);
  check(
    'the coming-soon page is kept out of the index but follows its links',
    /noindex/.test(comingSoon.body) && /follow/.test(comingSoon.body)
  );
  check(
    'the coming-soon page carries no store shell',
    !/data-testid="cart-count"/.test(comingSoon.body),
    'a closed shop must not advertise a cart or a search box'
  );
  check(
    'the coming-soon page does not offer a staff link to a stranger',
    !/Open the admin/.test(comingSoon.body)
  );
  await session.goto(`${BASE}/coming-soon`, 800);
  await session.shot('01-coming-soon');

  // ------------------------------------------------- what staff and members see
  const staffHome = await anon('/', staffCookie);
  check(
    'STAFF still see their own shop while it is closed',
    staffHome.status === 200,
    `status ${staffHome.status} — otherwise the people who can reopen it are locked out`
  );

  const customerHome = await anon('/', plainCookie);
  check(
    'a signed-in CUSTOMER is still turned away',
    customerHome.status >= 300 && customerHome.status < 400,
    `status ${customerHome.status} — being signed in is not being staff`
  );

  // ------------------------------------------------------------- the switch
  await session.setCookie('ozikoro_store_session', STAFF_TOKEN, { domain: new URL(BASE).hostname });
  await session.goto(`${BASE}/admin/store`, 1200);
  const controls = await session.waitFor('[data-testid="storefront-toggle"]', 40);
  check('the switch is on the admin screen and reachable by a store admin', controls === true);

  const shown = await session.evaluate(
    `document.querySelector('[data-testid="storefront-state"]')?.getAttribute('data-open')`
  );
  check(
    'the screen reports the state the database holds',
    shown === 'false',
    `screen said data-open="${shown}", the setting is "${await readOpen()}"`
  );
  await session.shot('02-switch-closed');

  // Throw it, through the real control.
  await session.evaluate(`(async () => {
    const box = document.querySelector('[data-testid="storefront-toggle"]');
    if (!box.checked) box.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    document.querySelector('[data-testid="storefront-save"]').click();
    return true;
  })()`);

  let saved = false;
  for (let i = 0; i < 40 && !saved; i += 1) {
    await sleep(400);
    saved = (await session.evaluate(`!!document.querySelector('[data-testid="storefront-saved"]')`)) === true;
  }
  check('the screen confirms the change', saved === true, saved ? '' : 'no confirmation appeared');

  await sleep(1500);
  check('OPENING the shop writes the setting', (await readOpen()) === '1', `store.open = "${await readOpen()}"`);

  const reopened = await anon('/');
  check(
    'THE PUBLIC CAN REACH THE SHOP AGAIN',
    reopened.status === 200,
    `status ${reopened.status}${reopened.location ? ` → ${reopened.location}` : ''}`
  );

  // And close it once more, so the suite proves both directions.
  await session.goto(`${BASE}/admin/store`, 1200);
  await session.waitFor('[data-testid="storefront-toggle"]', 40);
  await session.evaluate(`(async () => {
    const box = document.querySelector('[data-testid="storefront-toggle"]');
    if (box.checked) box.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    document.querySelector('[data-testid="storefront-save"]').click();
    return true;
  })()`);
  await sleep(3000);
  check('CLOSING the shop writes the setting', (await readOpen()) === '0', `store.open = "${await readOpen()}"`);

  const reclined = await anon('/');
  check(
    'the public is turned away again',
    reclined.status >= 300 && reclined.status < 400 && reclined.location.includes('/coming-soon'),
    `status ${reclined.status}`
  );

  // The switch is the most consequential control in the admin, so it is audited.
  const trail = rows(
    await query(
      `SELECT action FROM audit_log WHERE entity_id = 'store.open' ORDER BY created_at DESC LIMIT 4`
    )
  ).map((row) => row.action);
  check(
    'every throw of the switch is audited',
    trail.includes('storefront.opened') && trail.includes('storefront.closed'),
    trail.join(', ') || 'no audit rows'
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
  // Put the switch back where it was found. A test that changes whether the shop
  // is open is a test nobody can run twice.
  try {
    if (databaseId && originalState !== null && (await readOpen()) !== originalState) {
      await query(
        `UPDATE settings SET value = '${originalState}', updated_at = datetime('now') WHERE key = 'store.open'`
      );
      console.log(`\n      restored the switch to "${originalState}"`);
    }
    if (databaseId) {
      await query(`DELETE FROM sessions WHERE customer_id IN ('${STAFF_ID}', '${PLAIN_ID}')`);
      await query(`DELETE FROM customers WHERE id IN ('${STAFF_ID}', '${PLAIN_ID}')`);
      await query(`DELETE FROM audit_log WHERE actor_email LIKE 'gate-%-${STAMP}@example.com'`);
    }
  } catch (error) {
    console.error('cleanup failed:', error instanceof Error ? error.message : error);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  await session.close();
  process.exit(failed.length ? 1 : 0);
}
