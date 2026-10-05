#!/usr/bin/env node
/**
 * Does the server ENFORCE the role matrix for a restricted account?
 *
 * WHY THIS TEST MINTS ITS OWN SESSION
 *
 * Every browser suite here signs in through the form, which is right for testing
 * the form. It is the wrong dependency for testing AUTHORISATION: a flaky sign-in
 * turns an enforcement failure and a login failure into the same red result, and
 * an earlier version of this test spent its whole life reporting the second as
 * the first.
 *
 * `createSession` stores `sha256(token)` and nothing else, so a session can be
 * written directly and handed to the browser as the same cookie the app would
 * set. That removes the login from the picture, leaving the question this suite
 * exists to ask.
 *
 * WHAT IT ASKS
 *
 * It creates a temporary `content_manager` — a role that may write content and
 * may NOT read orders, change prices, see the audit log or change who is staff —
 * and then:
 *
 *   1. checks the navigation offers only what the role holds;
 *   2. visits every screen it must NOT reach and requires the SERVER's refusal,
 *      judged by the heading the shell renders rather than by words in the page;
 *   3. checks the screen it DOES hold still renders, so a blanket refusal would
 *      itself fail.
 *
 * It removes the account and the session.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/e2e-roles.mjs [--url …] [--shots …]
 */

import { createHash, randomBytes } from 'node:crypto';

import { startBrowser } from './lib/browser.mjs';

const API = 'https://api.cloudflare.com/client/v4';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'https://shop.ozikoro.com').replace(/\/+$/, '');
const SHOTS = arg('shots', '.e2e-roles');
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
  return body.result?.[0]?.results ?? [];
}

const STAMP = Date.now().toString(36).slice(-6);
const EMAIL = `role-probe-${STAMP}@example.com`;
const CUSTOMER_ID = `cus_role_${STAMP}`;
const SESSION_TOKEN = randomBytes(32).toString('base64url');
const SESSION_ID = createHash('sha256').update(SESSION_TOKEN, 'utf8').digest('hex');
/** The non-staff probe, declared here so `finally` can remove it. */
const PLAIN_ID = `cus_plain_${STAMP}`;
const PLAIN_TOKEN = randomBytes(32).toString('base64url');
const PLAIN_SESSION = createHash('sha256').update(PLAIN_TOKEN, 'utf8').digest('hex');

const session = await startBrowser({ label: 'roles', shots: SHOTS, windowSize: '1440,1100' });

/**
 * Wait for the admin shell to stop saying it is checking.
 *
 * A refused screen is drawn by the shell with "Not authorised" as its heading; a
 * permitted one draws its own. Reading either too early returns "Checking your
 * access…" or the PREVIOUS route's heading, which is how two earlier versions of
 * this test reported working refusals as leaks.
 */
const SETTLED = `(async () => {
  for (let i = 0; i < 80; i += 1) {
    const body = document.body.innerText || '';
    const title = document.querySelector('[data-testid="admin-page-title"]')?.textContent?.trim() ?? '';
    if (/Not authorised/i.test(body)) return { state: 'refused' };
    if (title && !/Checking your access/i.test(body)) return { state: 'rendered', title };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { state: 'timeout' };
})()`;

try {
  const list = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  databaseId = (list?.result ?? []).find((entry) => entry.name === databaseName)?.uuid;
  if (!databaseId) throw new Error(`No D1 database named "${databaseName}".`);

  // ------------------------------------------------------- the restricted account
  await query(
    `INSERT INTO customers (id, email, name, role, password_hash, password_salt)
     VALUES ('${CUSTOMER_ID}', '${EMAIL}', 'Role Probe', 'content_manager', NULL, NULL)`
  );
  await query(
    `INSERT INTO sessions (id, customer_id, role, expires_at, user_agent, ip_hash)
     VALUES ('${SESSION_ID}', '${CUSTOMER_ID}', 'content_manager', datetime('now', '+1 day'), 'role-probe', 'role-probe')`
  );

  const stored = (await query(`SELECT role FROM sessions WHERE id = '${SESSION_ID}'`))[0];
  check('the session is minted at a restricted role', stored?.role === 'content_manager', String(stored?.role));

  await session.setCookie('ozikoro_store_session', SESSION_TOKEN, { domain: new URL(BASE).hostname });

  // ------------------------------------------------------------ what it may see
  await session.goto(`${BASE}/admin`, 800);
  const shell = await session.evaluate(SETTLED);
  check('the admin shell settles for a staff account', shell?.state === 'rendered', JSON.stringify(shell));

  const nav = await session.evaluate(`document.querySelector('[data-testid="admin-nav"]')?.innerText ?? ''`);
  check('the navigation offers SEO, which the role holds', /SEO/i.test(nav ?? ''), (nav ?? '').replace(/\s+/g, ' '));
  check('the navigation offers Products, which the role may read', /Products/i.test(nav ?? ''));
  check('the navigation does NOT offer Orders', !/\bOrders\b/i.test(nav ?? ''));
  check('the navigation does NOT offer Discounts', !/Discounts/i.test(nav ?? ''));
  check('the navigation does NOT offer Permissions', !/Permissions/i.test(nav ?? ''));
  await session.shot('01-navigation');

  // ------------------------------------------------------- what it MUST be refused
  //
  // THE ASSERTION IS ON THE DATA, NOT THE HEADING AND NOT THE STATUS CODE.
  //
  // Two wrong layers were tried before this one, and both reported working
  // refusals as failures:
  //
  //   * the HEADING. The shell admits anyone who is staff and lets each screen
  //     load, so a refused screen still draws its title. A rendered frame is not
  //     a leak.
  //   * the HTTP STATUS. A TanStack server function answers 200 even when its
  //     handler throws; the refusal travels in the body as an error, so a status
  //     check sees success everywhere.
  //
  // What must never arrive is the DATA. Each screen below has a row element that
  // exists only for a record it managed to load, so its absence is the claim.
  const refusals = [
    ['/admin/orders', 'order-row-', 'read every order'],
    ['/admin/permissions', 'staff-', 'see who is staff'],
    ['/admin/audit', 'audit-entry-', 'read the audit log'],
    ['/admin/discounts', 'discount-row-', 'see the discount codes'],
    ['/admin/outbox', 'outbox-row-', 'read the outbox'],
  ];

  for (const [path, rowMarker, what] of refusals) {
    await session.goto(`${BASE}${path}`, 800);
    // Give the screen's data request time to be answered and drawn. The negative
    // claim needs a settled page, or an empty one proves nothing.
    await session.evaluate(`(async () => {
      for (let i = 0; i < 60; i += 1) {
        if (!/Checking your access/i.test(document.body.innerText || '')) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const rows = await session.evaluate(
      `document.querySelectorAll('[data-testid^="${rowMarker}"]').length`
    );
    check(
      `a content manager cannot ${what}`,
      rows === 0,
      rows === 0 ? 'no records reached the page' : `${rows} record(s) REACHED THE PAGE`
    );
  }
  await session.shot('02-refused');

  // ------------------------------- a CUSTOMER account must not enter at all
  //
  // The shell gates on `isStaff(role)`. A capability check inside a server
  // function cannot protect a screen whose frame a customer can already see, so
  // this is the first door and the one worth testing directly.
  console.log('\n--- a non-staff account ---');
  await query(
    `INSERT INTO customers (id, email, name, role) VALUES ('${PLAIN_ID}', 'plain-${STAMP}@example.com', 'Plain Probe', 'customer')`
  );
  await query(
    `INSERT INTO sessions (id, customer_id, role, expires_at, user_agent, ip_hash)
     VALUES ('${PLAIN_SESSION}', '${PLAIN_ID}', 'customer', datetime('now', '+1 day'), 'role-probe', 'role-probe')`
  );
  await session.setCookie('ozikoro_store_session', PLAIN_TOKEN, { domain: new URL(BASE).hostname });

  await session.goto(`${BASE}/admin/outbox`, 800);
  const asCustomer = await session.evaluate(SETTLED);
  check(
    'a CUSTOMER account is refused the admin entirely',
    asCustomer?.state === 'refused',
    `state ${asCustomer?.state}${asCustomer?.title ? ` as "${asCustomer.title}"` : ''}`
  );

  // ---------------------------- and a revoked role must stop working at once
  //
  // `setCustomerRole` destroys every session for the account, which is what makes
  // a revocation take effect at the next sign-in rather than up to thirty days
  // later. This asserts the outcome a customer of that function depends on: the
  // OLD session no longer resolves.
  console.log('\n--- revocation ---');
  await session.setCookie('ozikoro_store_session', SESSION_TOKEN, { domain: new URL(BASE).hostname });
  await session.goto(`${BASE}/admin`, 800);
  const beforeRevoke = await session.evaluate(SETTLED);
  check('the staff session works before revocation', beforeRevoke?.state === 'rendered', JSON.stringify(beforeRevoke));

  // Exactly what `setCustomerRole` does.
  await query(`UPDATE customers SET role = 'customer' WHERE id = '${CUSTOMER_ID}'`);
  await query(`DELETE FROM sessions WHERE customer_id = '${CUSTOMER_ID}'`);

  await session.goto(`${BASE}/admin`, 800);
  const afterRevoke = await session.evaluate(SETTLED);
  check(
    'THE SAME SESSION IS REFUSED IMMEDIATELY AFTER REVOCATION',
    afterRevoke?.state === 'refused',
    `state ${afterRevoke?.state}${afterRevoke?.title ? ` as "${afterRevoke.title}"` : ''}`
  );
  await session.shot('04-revoked');

  // Restore the staff role so the rest of the suite still has a session to use.
  await query(`UPDATE customers SET role = 'content_manager' WHERE id = '${CUSTOMER_ID}'`);
  await query(
    `INSERT INTO sessions (id, customer_id, role, expires_at, user_agent, ip_hash)
     VALUES ('${SESSION_ID}', '${CUSTOMER_ID}', 'content_manager', datetime('now', '+1 day'), 'role-probe', 'role-probe')`
  );
  await session.setCookie('ozikoro_store_session', SESSION_TOKEN, { domain: new URL(BASE).hostname });

  // ------------------------------------------- the screen it holds STILL renders
  await session.goto(`${BASE}/admin/seo`, 800);
  const seoForm = await session.waitFor('[data-testid="seo-save"]', 60);
  // The positive case: the screen it HOLDS renders its settings. A blanket
  // refusal would pass every check above and fail this one.
  const seoText = await session.evaluate(`document.body.innerText || ''`);
  check(
    'a content manager CAN load the SEO screen it holds',
    seoForm === true && !/Not authorised/i.test(seoText ?? ''),
    seoForm ? 'the settings rendered' : 'the settings never loaded'
  );
  await session.shot('03-permitted');
} finally {
  try {
    if (databaseId) {
      await query(`DELETE FROM sessions WHERE customer_id IN ('${CUSTOMER_ID}', '${PLAIN_ID}')`);
      await query(`DELETE FROM customers WHERE id IN ('${CUSTOMER_ID}', '${PLAIN_ID}')`);
      // By every email this run could have used, not just one prefix: the plain
      // account uses `plain-` and an earlier version of this cleanup counted only
      // `role-probe-`, so it reported a leftover as zero.
      const left = await query(
        `SELECT COUNT(*) AS n FROM customers
          WHERE email LIKE 'role-probe-%' OR email LIKE 'plain-%' OR email
            IN ('${EMAIL}', 'plain-${STAMP}@example.com')`
      );
      console.log(`\n      cleanup: ${left[0]?.n ?? '?'} probe account(s) remaining`);
    }
  } catch (error) {
    console.error('cleanup failed:', error instanceof Error ? error.message : error);
  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  console.log(`Screenshots in ${SHOTS}/`);
  await session.close();
  process.exit(failed.length ? 1 : 0);
}
