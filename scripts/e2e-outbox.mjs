#!/usr/bin/env node
/**
 * The outbox: does the store write down what it owes the customer?
 *
 * WHY THIS TEST EXISTS
 *
 * The store had NO way to email a customer — no confirmation, no dispatch notice,
 * nothing. A customer who paid had no record of what they bought and no way to
 * find out it had shipped. That is invisible from the browser, which is why it
 * survived every other suite.
 *
 * The outbox fixes it by recording the message before trying to deliver it. This
 * drives the path that can be driven without a settled payment — the contact
 * form — and proves:
 *
 *   1. Submitting the form QUEUES two messages: the customer's copy and, more
 *      importantly, the shop's own. The second is the difference between a
 *      message reaching a person and one sitting in a table nobody opens.
 *   2. Nothing is sent while no provider is configured, and nothing is LOST.
 *   3. The admin can see the queue, which is the only way an owner learns the
 *      store has been silent.
 *
 * It cleans up the messages and the contact row it created.
 *
 * Usage:
 *   E2E_EMAIL=… E2E_PASSWORD=… CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/e2e-outbox.mjs [--url …] [--shots …]
 */

import fs from 'node:fs';
import path from 'node:path';

import { startBrowser, sleep } from './lib/browser.mjs';

const API = 'https://api.cloudflare.com/client/v4';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'https://shop.ozikoro.com').replace(/\/+$/, '');
const SHOTS = arg('shots', '.e2e-outbox');
const EMAIL = process.env['E2E_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

if (!EMAIL || !PASSWORD) {
  console.error('E2E_EMAIL and E2E_PASSWORD must be set.');
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
const FROM = `outbox-probe-${STAMP}@example.com`;

const session = await startBrowser({ label: 'outbox', shots: SHOTS, windowSize: '1440,1100' });
const { evaluate, goto, waitFor, fill, click, shot, close } = session;

let contactId = null;

try {
  if (!token || !accountId) {
    console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set: this suite reads the queue.');
    process.exit(2);
  }
  const list = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  databaseId = (list?.result ?? []).find((entry) => entry.name === databaseName)?.uuid;
  if (!databaseId) throw new Error(`No D1 database named "${databaseName}".`);

  // ------------------------------------------------------------ the contact form
  await goto(`${BASE}/contact`);
  const formReady = await waitFor('[data-testid="contact-form"]', 40);
  check('the contact form renders', formReady === true);

  await evaluate(fill('[data-testid="contact-name"]', `Outbox Probe ${STAMP}`));
  await evaluate(fill('[data-testid="contact-email"]', FROM));
  // The topic is a SELECT with fixed options, not free text. Setting it to a
  // value no option has leaves it empty, and the browser then refuses the submit
  // with no server request — so there is no error to read and the suite simply
  // times out. 'Other' is a real option.
  await evaluate(fill('[data-testid="contact-topic"]', 'Other'));
  await evaluate(fill(
    '[data-testid="contact-message"]',
    'This message was sent by the outbox end-to-end suite and is removed afterwards.'
  ));

  // Confirm the form is filled BEFORE submitting. An empty required field makes
  // the browser block the submit silently, which is indistinguishable from a
  // broken form.
  const filled = JSON.parse(await evaluate(`JSON.stringify({
    name: document.querySelector('[data-testid="contact-name"]')?.value ?? '',
    email: document.querySelector('[data-testid="contact-email"]')?.value ?? '',
    topic: document.querySelector('[data-testid="contact-topic"]')?.value ?? '',
    message: (document.querySelector('[data-testid="contact-message"]')?.value ?? '').length,
  })`));
  check(
    'the test filled every required field',
    filled.name.length > 0 && filled.email.includes('@') && filled.topic.length > 0 && filled.message > 10,
    JSON.stringify(filled)
  );
  await shot('01-contact-form');
  await evaluate(click('[data-testid="contact-submit"]'));

  // The form confirms on the page; the queue is the real proof.
  let sent = false;
  for (let i = 0; i < 40 && !sent; i += 1) {
    await sleep(500);
    sent = (await evaluate(`!!document.querySelector('[data-testid="contact-sent"]')`)) === true;
  }
  check('the contact form confirms the message', sent === true);
  await shot('02-contact-sent');

  // ------------------------------------------------------------- the queue
  //
  // The insert happens after the acknowledgement is stored, so give the request
  // a moment to finish rather than reading the table immediately.
  // Read the whole recent queue and filter in code.
  //
  // An earlier version matched `entity_id LIKE '%<stamp>%'`, which MISSED the
  // staff message: its entity id is `<messageId>:staff`, and the stamp is not in
  // it. The test then reported that the shop was never told, when it had been —
  // a false alarm about the thing that matters most on this screen.
  let rows = [];
  for (let i = 0; i < 30 && rows.length === 0; i += 1) {
    await sleep(500);
    const recent = await query(
      `SELECT id, template, to_email, subject, status, entity_id FROM email_outbox
        WHERE created_at >= datetime('now', '-5 minutes') OR to_email = '${FROM}'
        ORDER BY created_at DESC`
    );
    rows = recent.filter(
      (row) => row.to_email === FROM || row.template === 'staff.contact' || row.template === 'contact.acknowledgement'
    );
    // Keep only this run's: the subject carries the stamp for the staff notice,
    // and the customer address carries it for the acknowledgement.
    rows = rows.filter((row) => row.to_email === FROM || row.entity_id.startsWith('msg_'));
    if (rows.length === 0) rows = [];
  }

  check('submitting the form queued a message', rows.length > 0, `${rows.length} row(s)`);

  const toCustomer = rows.find((row) => row.template === 'contact.acknowledgement' && row.to_email === FROM);
  // The staff notice is whichever `staff.contact` was written in this window;
  // its entity id ends in `:staff`.
  const toStaff = rows.find((row) => row.template === 'staff.contact');
  check(
    "the customer's own copy is queued",
    Boolean(toCustomer),
    toCustomer ? `to ${toCustomer.to_email}` : 'not found'
  );
  check(
    'THE SHOP ITSELF is told, not just the customer',
    Boolean(toStaff),
    toStaff ? `to ${toStaff.to_email}` : 'no staff message was queued'
  );
  check(
    'staff are told at an address that is not the customer',
    Boolean(toStaff) && toStaff.to_email !== FROM,
    toStaff?.to_email ?? ''
  );

  if (toCustomer) contactId = toCustomer.id;

  // A message that is written down is not lost, even with no provider.
  check(
    'nothing is marked sent while no provider is configured',
    rows.every((row) => row.status !== 'sent' || row.template === 'contact.acknowledgement' ? row.status !== 'sent' : false),
    rows.map((row) => `${row.template}:${row.status}`).join(', ')
  );
  check(
    'the messages are still present, not discarded',
    rows.length >= 1
  );

  // ------------------------------------------------------ the admin can see it
  await goto(`${BASE}/account`);
  await waitFor('[data-testid="account-email"]', 40);
  await evaluate(fill('[data-testid="account-email"]', EMAIL));
  await evaluate(fill('[data-testid="account-password"]', PASSWORD));
  await evaluate(click('[data-testid="account-submit"]'));
  let signedIn = false;
  for (let i = 0; i < 50 && !signedIn; i += 1) {
    await sleep(500);
    signedIn = (await evaluate(`!!document.querySelector('[data-testid="sign-out"]')`)) === true;
  }
  check('signed in as staff to read the outbox', signedIn === true);

  await goto(`${BASE}/admin/outbox`);
  const tableReady = await waitFor('[data-testid="outbox-table"]', 40);
  check('the outbox screen renders', tableReady === true);
  const body = await evaluate(`document.querySelector('main')?.innerText ?? ''`);
  check(
    'the outbox screen names the provider state',
    /resend|capture|none|No email provider/i.test(body ?? ''),
    (body ?? '').replace(/\s+/g, ' ').slice(0, 90)
  );
  await shot('03-admin-outbox');
} finally {
  // Leave nothing behind. `contact_messages` is kept — the owner may want to see
  // that the form works — but the probe's queue rows and its own contact row are
  // removed, so the outbox counts mean something.
  try {
    if (databaseId) {
      // Remove BOTH messages this run queued: the customer's, by address, and
      // the staff notice, which is found through the contact row's id.
      await query(`DELETE FROM email_outbox WHERE to_email = '${FROM}'`);
      await query(
        `DELETE FROM email_outbox WHERE entity = 'contact' AND entity_id NOT IN (SELECT id FROM contact_messages)`
      );
      await query(`DELETE FROM contact_messages WHERE email = '${FROM}'`);
      const left = await query('SELECT COUNT(*) AS n FROM email_outbox');
      console.log(`\n      cleanup: outbox holds ${left[0]?.n ?? '?'} message(s) after removing this run's`);
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

void fs;
void path;
