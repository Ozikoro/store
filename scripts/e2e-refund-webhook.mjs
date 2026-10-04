#!/usr/bin/env node
/**
 * The refund lifecycle, end to end, against the deployed store.
 *
 * WHY THIS IS A SCRIPT AND NOT A BROWSER SUITE
 *
 * A refund cannot be driven from the browser without a real paid order, and a
 * real paid order needs a card. The part that can be tested without one is the
 * part that was wrong:
 *
 *   A REFUND IS ASYNCHRONOUS. Paystack ACCEPTS it and settles it later, reporting
 *   `processing` in the meantime. The outcome normally arrives as a
 *   `refund.processed` or `refund.failed` webhook.
 *
 * The implementation used to treat acceptance as completion — marking the refund
 * completed and restocking the goods immediately — while the webhook acknowledged
 * both outcomes and changed nothing. So a refund that later failed left the
 * customer recorded as refunded, the stock back on the shelf, and no money
 * returned. Paystack's refund payload also carries no `data.reference`, and the
 * handler rejected any event without one before it reached the refund branch, so
 * no refund event could ever have been processed.
 *
 * This drives the real webhook with REAL signed payloads shaped the way Paystack
 * sends refunds, and asserts the state transitions. It plants its own fixtures and
 * removes them, and it refuses to run against an order that has a real payment.
 *
 * Usage:
 *   PAYSTACK_SECRET_KEY=… CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/e2e-refund-webhook.mjs [--url https://shop.ozikoro.com]
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

const REFUND_ID = 'ref_e2e_webhook';
const REFUND_PROVIDER_ID = '99001122';
const REFUND_PROVIDER_ID_2 = '99003344';

/** Deliver a signed payload exactly as Paystack would. */
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

/** A refund payload shaped the way Paystack sends one: no `data.reference`. */
function refundEvent(kind, providerId, status) {
  return {
    event: kind,
    data: {
      id: Number(providerId),
      status,
      amount: 26500,
      currency: 'NGN',
      gateway_response: status === 'failed' ? 'insufficient balance at source' : undefined,
      // The original transaction, which is where the reference actually lives.
      transaction: { reference: 'OZKMUUB452NOAJJ16' },
    },
  };
}

let orderId = null;

async function main() {
  const databases = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const database = (databases?.result ?? []).find((entry) => entry.name === databaseName);
  if (!database) throw new Error(`No D1 database named "${databaseName}".`);
  databaseId = database.uuid;

  // An order with NO settled payment, so nothing here can touch real money.
  const candidates = await query(
    `SELECT o.id, o.number FROM orders o
      WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id AND p.status = 'success')
      ORDER BY o.created_at LIMIT 1`
  );
  orderId = candidates[0]?.id;
  if (!orderId) {
    console.error('No unpaid order is available to attach fixtures to.');
    process.exit(2);
  }
  console.log(`Using order ${candidates[0].number} (no settled payment).\n`);

  const before = await query('SELECT SUM(stock) AS stock FROM product_variants');
  const stockBefore = Number(before[0]?.stock ?? 0);

  await cleanup();

  // ---------------------------------------------------------------- processed
  console.log('--- refund.processed ---');
  await query(
    `INSERT INTO refunds (id, order_id, amount_minor, reason, status, provider_reference, restock, created_by)
     VALUES ('${REFUND_ID}', '${orderId}', 26500, 'end-to-end probe', 'processing', '${REFUND_PROVIDER_ID}', 0, 'e2e')`
  );
  await query(`UPDATE orders SET status = 'partially_refunded' WHERE id = '${orderId}'`);

  const processed = await deliver(refundEvent('refund.processed', REFUND_PROVIDER_ID, 'processed'));
  check(
    'a refund.processed delivery is accepted',
    processed.status === 200,
    `HTTP ${processed.status}`
  );
  check(
    'it is HANDLED, not acknowledged and discarded',
    processed.json?.handled === true,
    JSON.stringify(processed.json)
  );
  // The reference proves `data.transaction.reference` was read even though the
  // event carries no `data.reference` — the shape that used to be rejected.
  check(
    'the transaction reference is taken from data.transaction',
    processed.json?.reference === 'OZKMUUB452NOAJJ16',
    String(processed.json?.reference)
  );

  const settled = await query(`SELECT status FROM refunds WHERE id = '${REFUND_ID}'`);
  check(
    'the refund is settled',
    settled[0]?.status === 'completed',
    String(settled[0]?.status)
  );

  const afterProcessed = await query('SELECT SUM(stock) AS stock FROM product_variants');
  check(
    'a refund that asked for no restock leaves stock alone',
    Number(afterProcessed[0]?.stock ?? 0) === stockBefore,
    `${stockBefore} -> ${afterProcessed[0]?.stock}`
  );

  // ------------------------------------------------------------------- failed
  console.log('\n--- refund.failed ---');
  await query(`DELETE FROM refunds WHERE id = '${REFUND_ID}'`);
  await query(`DELETE FROM webhook_events WHERE event_type LIKE 'refund.%'`);
  await query(
    `INSERT INTO refunds (id, order_id, amount_minor, reason, status, provider_reference, restock, created_by)
     VALUES ('${REFUND_ID}', '${orderId}', 26500, 'end-to-end probe', 'processing', '${REFUND_PROVIDER_ID_2}', 0, 'e2e')`
  );
  await query(`UPDATE orders SET status = 'partially_refunded', payment_status = 'paid' WHERE id = '${orderId}'`);

  const failed = await deliver(refundEvent('refund.failed', REFUND_PROVIDER_ID_2, 'failed'));
  check('a refund.failed delivery is accepted', failed.status === 200, `HTTP ${failed.status}`);
  check('it is handled', failed.json?.handled === true, JSON.stringify(failed.json));

  const released = await query(`SELECT status, reason FROM refunds WHERE id = '${REFUND_ID}'`);
  check('the refund is recorded as failed', released[0]?.status === 'failed', String(released[0]?.status));
  check(
    "the gateway's reason is kept",
    String(released[0]?.reason ?? '').includes('insufficient balance'),
    String(released[0]?.reason ?? '').slice(0, 60)
  );

  // THE ORDER-STATE FIX. Nothing was refunded, so the order must stop saying it
  // was. Left `partially_refunded`, an operator believes money went out.
  const order = await query(`SELECT status FROM orders WHERE id = '${orderId}'`);
  check(
    'an order with nothing refunded returns to paid',
    order[0]?.status === 'paid',
    String(order[0]?.status)
  );

  // ------------------------------------------------------------- idempotency
  console.log('\n--- a repeat delivery ---');
  const repeat = await deliver(refundEvent('refund.failed', REFUND_PROVIDER_ID_2, 'failed'));
  check(
    'a repeat delivery is recognised as a duplicate',
    repeat.json?.reason === 'duplicate delivery',
    JSON.stringify(repeat.json)
  );

  // ------------------------------------------------------- unregistered refund
  console.log('\n--- an unknown refund ---');
  const unknown = await deliver(refundEvent('refund.processed', '11112222', 'processed'));
  check('an unknown refund is not fatal', unknown.status === 200, `HTTP ${unknown.status}`);
  check(
    'and is reported as unmatched rather than settled',
    unknown.json?.handled === false,
    JSON.stringify(unknown.json)
  );

  await cleanup();
}

async function cleanup() {
  if (!databaseId) return;
  try {
    await query(`DELETE FROM refunds WHERE id = '${REFUND_ID}'`);
    await query(`DELETE FROM webhook_events WHERE event_type LIKE 'refund.%'`);
    if (orderId) {
      await query(`UPDATE orders SET status = 'cancelled', payment_status = 'unpaid' WHERE id = '${orderId}'`);
    }
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
const after = await query('SELECT SUM(stock) AS stock FROM product_variants');
const leftovers = await query(`SELECT COUNT(*) AS n FROM refunds WHERE id LIKE 'ref_%'`);

const failedChecks = results.filter((result) => !result.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed.`);
for (const result of failedChecks) console.log(`  - ${result.name}: ${result.detail}`);
console.log(`Store left with ${leftovers[0]?.n ?? '?'} refund row(s) and ${after[0]?.stock ?? '?'} units of stock.`);
process.exit(failedChecks.length ? 1 : 0);
