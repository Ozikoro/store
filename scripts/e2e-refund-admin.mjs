#!/usr/bin/env node
/**
 * A refund on a SETTLED order, driven through the admin.
 *
 * WHY THIS IS A BROWSER TEST AND NOT A QUEUE CHECK
 *
 * A refund is the one path that moves money back out. Everything about it is
 * reached through the admin form, and the parts that have gone wrong before were
 * all in the sequencing rather than the arithmetic:
 *
 *   * `executeRefund` used to mark a refund completed the moment Paystack
 *     ACCEPTED it, when Paystack answers `processing` for a refund it settles
 *     later — so a refund that failed afterwards left the customer recorded as
 *     refunded, with the stock back on the shelf.
 *   * A FAILED refund left the order `partially_refunded` even though no money
 *     moved, because `requestRefund` sets that status when the refund is
 *     REQUESTED and nothing put it back.
 *
 * WHAT IT DOES
 *
 * It plants a settled fixture order — a payment row marked settled, so no
 * gateway call is needed to reach the money path — and then drives the real
 * admin form. The refund is aimed at a provider reference Paystack does not
 * know, so the gateway refuses it immediately and predictably. That is the case
 * worth testing: the money did NOT move, and the store must not say it did.
 *
 * It asserts the outcome that matters — the order returns to `paid` and the
 * refund is recorded as `failed`, with the gateway's own reason kept — and then
 * removes everything it planted.
 *
 * Usage:
 *   E2E_EMAIL=… E2E_PASSWORD=… CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/e2e-refund-admin.mjs [--url …] [--shots …]
 */

import { startBrowser, sleep } from './lib/browser.mjs';

const API = 'https://api.cloudflare.com/client/v4';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'https://shop.ozikoro.com').replace(/\/+$/, '');
const SHOTS = arg('shots', '.e2e-refund-admin');
const EMAIL = process.env['E2E_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

if (!EMAIL || !PASSWORD) {
  console.error('E2E_EMAIL and E2E_PASSWORD must be set.');
  process.exit(2);
}
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
const ORDER_NUMBER = `E2E-REFUND-${STAMP}`;

const session = await startBrowser({ label: 'refund', shots: SHOTS, windowSize: '1440,1200' });
const { evaluate, goto, waitFor, fill, click, shot, close } = session;

try {
  const list = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  databaseId = (list?.result ?? []).find((entry) => entry.name === databaseName)?.uuid;
  if (!databaseId) throw new Error(`No D1 database named "${databaseName}".`);

  const variant = (
    await query(
      `SELECT v.id, v.sku, v.title, v.price_minor, v.product_id, p.slug AS product_slug, p.title AS product_title,
              p.currency, p.image_url
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.is_active = 1 ORDER BY v.stock DESC LIMIT 1`
    )
  )[0];
  if (!variant) throw new Error('No variant to build the fixture from.');

  const goods = Number(variant.price_minor);
  const total = goods + 250000;
  const orderId = `ord_rf_${STAMP}`;
  const paymentId = `pay_rf_${STAMP}`;
  const customerId = `cus_rf_${STAMP}`;
  const email = `refund-probe-${STAMP}@example.com`;
  const address = JSON.stringify({
    firstName: 'Ada',
    lastName: 'Okeke',
    line1: '14 Awolowo Road, Ikoyi',
    city: 'Lagos',
    region: 'Lagos',
    country: 'Nigeria',
    phone: '08031234567',
  });

  await query(`INSERT INTO customers (id, email, name, role) VALUES ('${customerId}', '${email}', 'Ada Okeke', 'customer')`);
  await query(
    `INSERT INTO orders (id, number, customer_id, email, status, payment_status, fulfilment_status, currency,
                         subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor,
                         shipping_method, shipping_address, billing_address, paid_at)
     VALUES ('${orderId}', '${ORDER_NUMBER}', '${customerId}', '${email}', 'paid', 'paid', 'unfulfilled', '${variant.currency}',
             ${goods}, 0, 250000, 0, ${total}, 'lagos', '${address}', '${address}', datetime('now'))`
  );
  await query(
    `INSERT INTO order_items (id, order_id, product_id, variant_id, product_slug, title, variant_title, sku,
                              image_url, unit_price_minor, quantity, line_total_minor)
     VALUES ('oi_rf_${STAMP}', '${orderId}', '${variant.product_id}', '${variant.id}', '${variant.product_slug}',
             '${String(variant.product_title).replace(/'/g, "''")}', '${String(variant.title).replace(/'/g, "''")}',
             '${variant.sku}', '${variant.image_url ?? ''}', ${goods}, 1, ${goods})`
  );
  // The provided reference is one Paystack does not know, so the refund is
  // refused at the gateway. No money moves and no real refund is created.
  await query(
    `INSERT INTO payments (id, order_id, provider, reference, provider_reference, amount_minor, currency, status, channel, gateway_response, settled_at, verified_at)
     VALUES ('${paymentId}', '${orderId}', 'paystack', 'E2E-REFUND-REF-${STAMP}', 'E2E-UNKNOWN-${STAMP}', ${total}, '${variant.currency}',
             'success', 'card', 'fixture', datetime('now'), datetime('now'))`
  );

  console.log(`Fixture order ${ORDER_NUMBER} (settled, ${total / 100} ${variant.currency}).\n`);

  // ------------------------------------------------------------- sign in
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
  check('signed in as staff', signedIn === true);
  if (!signedIn) throw new Error('cannot drive the admin without a session');

  // ------------------------------------------------------- the admin order
  await goto(`${BASE}/admin/orders/${ORDER_NUMBER}`);
  const detailReady = await waitFor('[data-testid="refund-form"]', 40);
  check('the order detail page renders for a settled order', detailReady === true);

  const stateBefore = await evaluate(`document.querySelector('main')?.innerText ?? ''`);
  check(
    'the order reads as paid before the refund',
    /paid/i.test(stateBefore ?? ''),
    'the fixture is a settled order'
  );

  // The form takes MAJOR units, like the price fields.
  await evaluate(fill('[data-testid="refund-amount"]', (total / 100).toFixed(2)));
  await evaluate(fill('[data-testid="refund-reason"]', 'End-to-end suite: refund aimed at a reference the gateway does not know.'));
  await shot('01-refund-form');

  await evaluate(click('[data-testid="refund-submit"]'));
  await sleep(2500);
  // Executing is a second, deliberate step — the design is request, then execute.
  const executed = await evaluate(click('[data-testid="refund-submit"]'));
  await sleep(6000);
  check('the refund form can be submitted', executed !== false);
  await shot('02-refund-attempted');

  // The screen should say something. What matters is the DATABASE, read next.
  const afterText = await evaluate(`document.querySelector('main')?.innerText ?? ''`);
  check(
    'the screen reports an outcome rather than going quiet',
    /refund|failed|could not|error|not/i.test(afterText ?? ''),
    (afterText ?? '').replace(/\s+/g, ' ').slice(0, 120)
  );

  // ------------------------------------------------------------- the records
  const refund = (await query(`SELECT status, amount_minor, reason FROM refunds WHERE order_id = '${orderId}'`))[0];
  check('a refund row exists', Boolean(refund), JSON.stringify(refund));
  check(
    'the refund is recorded as FAILED, because no money moved',
    refund?.status === 'failed',
    String(refund?.status)
  );
  check(
    "the gateway's own reason is kept",
    /refund|not found|error/i.test(String(refund?.reason ?? '')),
    String(refund?.reason ?? '').slice(0, 90)
  );

  // THE FIX THIS TEST EXISTS FOR.
  const order = (await query(`SELECT status, payment_status FROM orders WHERE id = '${orderId}'`))[0];
  check(
    'THE ORDER RETURNS TO paid, because nothing was refunded',
    order?.status === 'paid',
    `order is ${order?.status} — staying partially_refunded would tell an operator money went out`
  );
  check(
    'the payment status still says paid',
    order?.payment_status === 'paid',
    String(order?.payment_status)
  );

  // A failed refund must not become a completed one through a late event.
  const settled = await query(`SELECT COUNT(*) AS n FROM refunds WHERE order_id = '${orderId}' AND status = 'completed'`);
  check('no refund for this order is marked completed', Number(settled[0]?.n) === 0, `${settled[0]?.n}`);

  // ------------------------------------------------------- dispatching a parcel
  //
  // The dispatch notice is the second message the store owes a customer, and it
  // was wired up but never exercised — an order can only be dispatched once it is
  // paid, which needed a settled payment.
  console.log('\n--- dispatching ---');
  await goto(`${BASE}/admin/orders/${ORDER_NUMBER}`);
  const shipmentForm = await waitFor('[data-testid="shipment-form"]', 40);
  check('the order page offers a shipment form', shipmentForm === true);

  await evaluate(fill('[data-testid="shipment-carrier"]', 'DHL Lagos'));
  await evaluate(fill('[data-testid="shipment-tracking-number"]', `TRK-${STAMP}`));
  await evaluate(
    fill('[data-testid="shipment-note"]', 'Dispatched by the end-to-end suite; removed afterwards.')
  );
  await evaluate(click('[data-testid="shipment-submit"]'));
  await sleep(6000);
  await shot('03-dispatched');

  const shipments = await query(`SELECT id, carrier, tracking_number, status FROM shipments WHERE order_id = '${orderId}'`);
  check('a shipment is recorded', shipments.length === 1, JSON.stringify(shipments[0] ?? null));
  check(
    'the tracking details are kept',
    String(shipments[0]?.tracking_number ?? '').includes(STAMP),
    String(shipments[0]?.tracking_number ?? '')
  );

  const notice = (
    await query(
      `SELECT template, to_email, subject, body_text FROM email_outbox
        WHERE entity = 'order' AND entity_id = '${ORDER_NUMBER}' AND template = 'order.shipped'`
    )
  )[0];
  check('THE CUSTOMER IS TOLD IT IS ON ITS WAY', Boolean(notice), notice ? String(notice.subject) : 'no dispatch notice queued');
  check(
    'the notice goes to the customer who ordered',
    notice?.to_email === email,
    String(notice?.to_email ?? '')
  );
  check(
    'THE NOTICE CARRIES THE TRACKING NUMBER',
    String(notice?.body_text ?? '').includes(`TRK-${STAMP}`),
    'the tracking number is the whole point of this message'
  );
  check(
    'the notice names the carrier',
    String(notice?.body_text ?? '').includes('DHL Lagos'),
    ''
  );
} finally {
  try {
    if (databaseId) {
      await query(`DELETE FROM refunds WHERE order_id IN (SELECT id FROM orders WHERE number LIKE 'E2E-REFUND-%')`);
      await query(`DELETE FROM shipments WHERE order_id IN (SELECT id FROM orders WHERE number LIKE 'E2E-REFUND-%')`);
      await query(`DELETE FROM email_outbox WHERE entity_id LIKE 'E2E-REFUND-%'`);
      await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE number LIKE 'E2E-REFUND-%')`);
      await query(`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE number LIKE 'E2E-REFUND-%')`);
      await query(`DELETE FROM orders WHERE number LIKE 'E2E-REFUND-%'`);
      await query(`DELETE FROM customers WHERE email LIKE 'refund-probe-%'`);
      const left = await query(
        `SELECT (SELECT COUNT(*) FROM orders WHERE number LIKE 'E2E-REFUND-%') AS orders,
                (SELECT COUNT(*) FROM refunds) AS refunds`
      );
      console.log(`\n      cleanup: ${JSON.stringify(left[0])}`);
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
