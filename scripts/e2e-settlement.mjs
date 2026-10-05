#!/usr/bin/env node
/**
 * A settled payment, end to end — without a card.
 *
 * WHY THIS IS POSSIBLE, AND WHY IT IS HONEST
 *
 * The one thing that has never been verified is what happens AFTER a payment
 * settles: the order becomes paid, the stock stays down, and the customer is
 * told. That needed a real card, which no test can supply.
 *
 * It does not need one. `confirmOrderPayment` checks whether the payment is
 * ALREADY SETTLED before it asks the gateway, precisely so the callback and the
 * webhook can race harmlessly. So a payment row that is already marked settled
 * exercises every line of the settlement path with NO network call to Paystack
 * and no money involved — the fixture is the payment, and the fixture is removed
 * afterwards.
 *
 * WHAT IT PROVES
 *
 *   1. A signed `charge.success` delivery settles the order: `paid`, with
 *      `paid_at` set.
 *   2. THE CONFIRMATION IS QUEUED, with the customer's address, the items and the
 *      total. This is the message whose absence left a paying customer with no
 *      record at all.
 *   3. A second delivery — the callback and the webhook racing, which is the
 *      normal case, not an edge — does NOT queue a second confirmation. Two
 *      confirmations for one order read as a double charge.
 *   4. Stock stays reserved. A settled order must not put goods back on the shelf.
 *
 * It plants its own order, payment and contact-free customer, and removes all of
 * them. It never touches a real order or a real payment.
 *
 * Usage:
 *   PAYSTACK_SECRET_KEY=… CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/e2e-settlement.mjs [--url https://shop.ozikoro.com]
 */

import { createHmac } from 'node:crypto';
import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';
const BASE = (() => {
  const index = process.argv.indexOf('--url');
  return (index === -1 ? 'https://shop.ozikoro.com' : process.argv[index + 1]).replace(/\/+$/, '');
})();

const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const paystackKey = process.env['PAYSTACK_SECRET_KEY'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

for (const [name, value] of [
  ['CLOUDFLARE_API_TOKEN', token],
  ['CLOUDFLARE_ACCOUNT_ID', accountId],
  ['PAYSTACK_SECRET_KEY', paystackKey],
]) {
  if (!value) {
    console.error(`${name} must be set.`);
    process.exit(2);
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

let databaseId = null;
let orderNumber = null;
let reference = null;

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

async function deliver(event) {
  const body = JSON.stringify(event);
  const signature = createHmac('sha512', paystackKey).update(body, 'utf8').digest('hex');
  const response = await fetch(`${BASE}/api/webhooks/paystack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
    body,
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const STAMP = Date.now().toString(36).slice(-6);

async function main() {
  const list = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  databaseId = (list?.result ?? []).find((entry) => entry.name === databaseName)?.uuid;
  if (!databaseId) throw new Error(`No D1 database named "${databaseName}".`);

  const stockBefore = Number((await query('SELECT SUM(stock) AS n FROM product_variants'))[0]?.n ?? 0);

  // A variant that exists, so the order can reference real goods.
  const variant = (
    await query(
      `SELECT v.id, v.sku, v.title, v.price_minor, v.product_id, p.slug AS product_slug, p.title AS product_title,
              p.currency, p.image_url
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE v.is_active = 1 AND v.stock > 0
        ORDER BY v.stock DESC LIMIT 1`
    )
  )[0];
  if (!variant) throw new Error('No in-stock variant to build a fixture order from.');

  orderNumber = `E2E-SETTLE-${STAMP}`;
  reference = `E2E-SETTLE-REF-${STAMP}`;
  const orderId = `ord_e2e_${STAMP}`;
  const paymentId = `pay_e2e_${STAMP}`;
  const customerId = `cus_e2e_${STAMP}`;
  const email = `settle-probe-${STAMP}@example.com`;
  const amount = Number(variant.price_minor) * 1;
  const address = JSON.stringify({
    firstName: 'Ada',
    lastName: 'Okeke',
    line1: '14 Awolowo Road, Ikoyi',
    city: 'Lagos',
    region: 'Lagos',
    country: 'Nigeria',
    phone: '08031234567',
  });

  // The payment must equal the ORDER TOTAL, which includes shipping. The first
  // version of this fixture asserted only the goods, so `settlePayment`'s amount
  // check correctly refused it and the order stayed pending — which is the guard
  // working, not a fault. Getting this wrong in the other direction, by relaxing
  // the check, would let a customer pay less than the order says.
  const total = amount + 250000;

  await query(
    `INSERT INTO customers (id, email, name, role) VALUES ('${customerId}', '${email}', 'Ada Okeke', 'customer')`
  );
  await query(
    `INSERT INTO orders (id, number, customer_id, email, status, payment_status, fulfilment_status, currency,
                         subtotal_minor, discount_minor, shipping_minor, tax_minor, total_minor,
                         shipping_method, shipping_address, billing_address)
     VALUES ('${orderId}', '${orderNumber}', '${customerId}', '${email}', 'pending', 'unpaid', 'unfulfilled', '${variant.currency}',
             ${amount}, 0, 250000, 0, ${total}, 'lagos', '${address}', '${address}')`
  );
  await query(
    `INSERT INTO order_items (id, order_id, product_id, variant_id, product_slug, title, variant_title, sku,
                              image_url, unit_price_minor, quantity, line_total_minor)
     VALUES ('oi_e2e_${STAMP}', '${orderId}', '${variant.product_id}', '${variant.id}', '${variant.product_slug}',
             '${String(variant.product_title).replace(/'/g, "''")}', '${String(variant.title).replace(/'/g, "''")}',
             '${variant.sku}', '${variant.image_url ?? ''}', ${amount}, 1, ${amount})`
  );

  // THE FIXTURE IS THE PAYMENT, and it is marked settled so the settlement path
  // never calls the gateway. No network, no money.
  await query(
    `INSERT INTO payments (id, order_id, provider, reference, provider_reference, amount_minor, currency, status, channel, gateway_response, settled_at, verified_at)
     VALUES ('${paymentId}', '${orderId}', 'paystack', '${reference}', 'E2E-PROVIDER-${STAMP}', ${total}, '${variant.currency}',
             'success', 'card', 'fixture: already settled, no gateway call is made', datetime('now'), datetime('now'))`
  );

  console.log(`Fixture order ${orderNumber} (goods ${amount / 100} + shipping, ${variant.currency}) on ${variant.sku}.\n`);

  // Confirm the fixture is what it claims to be BEFORE driving anything. A
  // fixture that did not insert produces a failure that looks exactly like a
  // broken settlement path.
  const planted = (
    await query(
      `SELECT o.status AS order_status, o.payment_status, o.total_minor, p.status AS pay_status,
              p.settled_at, p.amount_minor
         FROM orders o JOIN payments p ON p.order_id = o.id
        WHERE o.number = '${orderNumber}'`
    )
  )[0];
  check(
    'the fixture is in place: an order with a settled payment',
    planted?.pay_status === 'success' && Boolean(planted?.settled_at),
    JSON.stringify(planted)
  );
  check(
    'the fixture amount matches the order total, so the amount check passes',
    Number(planted?.amount_minor) === Number(planted?.total_minor),
    `payment ${planted?.amount_minor} vs order ${planted?.total_minor}`
  );

  // ------------------------------------------------------------ 1. settle it
  console.log('--- a signed charge.success ---');
  const delivered = await deliver({
    event: 'charge.success',
    data: { reference, id: 11223344, status: 'success', amount: total, currency: variant.currency, gateway_response: 'Successful' },
  });
  check('the delivery is accepted', delivered.status === 200, `HTTP ${delivered.status} JSON ${JSON.stringify(delivered.json)}`);

  const order = (await query(`SELECT status, payment_status, paid_at FROM orders WHERE id = '${orderId}'`))[0];
  check('the order becomes paid', order?.status === 'paid', `status ${order?.status}`);
  check('the payment status is paid', order?.payment_status === 'paid', String(order?.payment_status));
  check('the paid timestamp is set', Boolean(order?.paid_at), String(order?.paid_at));

  // ------------------------------------------------------- 2. the confirmation
  console.log('\n--- the customer is told ---');
  const mails = await query(
    `SELECT id, template, to_email, subject, body_text, status FROM email_outbox
      WHERE entity = 'order' AND entity_id = '${orderNumber}'`
  );
  check('a confirmation is queued for the order', mails.length === 1, `${mails.length} message(s)`);

  const confirmation = mails[0];
  check(
    'it goes to the customer who paid',
    confirmation?.to_email === email,
    String(confirmation?.to_email)
  );
  check(
    'the subject carries the order number, so it is findable',
    String(confirmation?.subject ?? '').includes(orderNumber),
    String(confirmation?.subject)
  );
  const body = String(confirmation?.body_text ?? '');
  check('the body names the order', body.includes(orderNumber));
  check('the body names the item', body.includes(String(variant.product_title)), String(variant.product_title));
  check('the body shows the total', /Total\s/.test(body), body.split('\n').find((l) => l.startsWith('Total')) ?? '');
  check(
    'THE BODY REPEATS THE DELIVERY ADDRESS',
    body.includes('Awolowo Road') && body.includes('Lagos'),
    'this is what people search for when a parcel is late'
  );
  check('the body carries the payment reference', body.includes(reference));

  // -------------------------------------------- 3. the race queues it once only
  console.log('\n--- the callback and the webhook racing ---');
  const again = await deliver({
    event: 'charge.success',
    data: { reference, id: 11223344, status: 'success', amount: total, currency: variant.currency, gateway_response: 'Successful' },
  });
  check('the repeat delivery is handled', again.status === 200, JSON.stringify(again.json));

  const after = await query(
    `SELECT COUNT(*) AS n FROM email_outbox WHERE entity = 'order' AND entity_id = '${orderNumber}'`
  );
  check(
    'a second settlement does NOT send a second confirmation',
    Number(after[0]?.n) === 1,
    `${after[0]?.n} message(s) — two would read as a double charge`
  );

  // ------------------------------------------------------------- 4. the stock
  console.log('\n--- stock ---');
  const stockAfter = Number((await query('SELECT SUM(stock) AS n FROM product_variants'))[0]?.n ?? 0);
  check(
    'settling does not return the goods to the shelf',
    stockAfter === stockBefore,
    `${stockBefore} -> ${stockAfter}`
  );
}

async function cleanup() {
  if (!databaseId) return;
  try {
    // By PREFIX, not by this run's identifiers. An earlier run that failed left
    // two fixture orders behind, and a cleanup that only knows its own names
    // cannot remove what a previous one abandoned.
    await query(`DELETE FROM email_outbox WHERE entity_id LIKE 'E2E-SETTLE-%' OR to_email LIKE 'settle-probe-%'`);
    await query(`DELETE FROM payments WHERE reference LIKE 'E2E-SETTLE-REF-%'`);
    await query(
      `DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE number LIKE 'E2E-SETTLE-%')`
    );
    await query(`DELETE FROM orders WHERE number LIKE 'E2E-SETTLE-%'`);
    await query(`DELETE FROM customers WHERE email LIKE 'settle-probe-%'`);
  } catch (error) {
    console.error('cleanup failed:', error instanceof Error ? error.message : error);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await cleanup();
  process.exit(1);
}

await cleanup();
const left = await query(
  `SELECT (SELECT COUNT(*) FROM orders WHERE number LIKE 'E2E-SETTLE-%') AS orders,
          (SELECT COUNT(*) FROM payments WHERE reference LIKE 'E2E-SETTLE-REF-%') AS payments,
          (SELECT COUNT(*) FROM email_outbox WHERE entity_id LIKE 'E2E-SETTLE-%') AS mails,
          (SELECT SUM(stock) FROM product_variants) AS stock`
);

const failedChecks = results.filter((result) => !result.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed.`);
for (const result of failedChecks) console.log(`  - ${result.name}: ${result.detail}`);
console.log(`Store left with: ${JSON.stringify(left[0])}`);
process.exit(failedChecks.length ? 1 : 0);
