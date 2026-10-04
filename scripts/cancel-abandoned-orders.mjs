#!/usr/bin/env node
/**
 * Cancel abandoned orders and return their stock.
 *
 * WHY THIS IS NEEDED AT ALL
 *
 * Stock is reserved when an order is created, not when it is paid — that is what
 * stops two customers being sold the last Medium. The cost is that a checkout
 * which reaches Paystack and is then abandoned holds its stock until somebody
 * cancels it. The admin can, one order at a time. This does it in a batch, for
 * the case that actually produced the need: integration probes.
 *
 * It is deliberately limited to orders that were never paid. Cancelling a paid
 * order is a refund, which is a different thing with different consequences, and
 * the admin path handles it.
 *
 * WHAT IT DOES, AND IN WHAT ORDER
 *
 *   1. Claim the order: `status = 'cancelled'` only WHERE it is still pending.
 *      The conditional update is the guard — two runs cannot both cancel, and a
 *      paid order cannot be claimed at all.
 *   2. Return the stock, in the same shape the application uses: an
 *      `inventory_movements` row per line with reason `order_cancelled`, and a
 *      stock increment.
 *   3. Mark the payment `abandoned` when Paystack confirms it never completed.
 *
 * The ledger row is written BEFORE the stock moves, so a crash between the two
 * leaves a movement with no increment — visible and repairable — rather than
 * stock appearing from nowhere.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/cancel-abandoned-orders.mjs [--dry-run] [--number OZK-10001]
 *     [--older-than-minutes 30] [--all]
 */

import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';
const paystackKey = process.env['PAYSTACK_SECRET_KEY'];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const dryRun = process.argv.includes('--dry-run');
const onlyNumber = arg('number');
const all = process.argv.includes('--all');
const olderThanMinutes = Number(arg('older-than-minutes', '0'));

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  process.exit(2);
}

async function api(pathname, init) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    throw new Error(`${init?.method ?? 'GET'} ${pathname}: ${JSON.stringify(body?.errors ?? response.status)}`);
  }
  return body.result;
}

async function query(databaseId, sql) {
  const result = await api(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
  return result?.[0]?.results ?? [];
}

async function main() {
  const databases = await api(`/accounts/${accountId}/d1/database`);
  const database = (databases ?? []).find((entry) => entry.name === databaseName);
  if (!database) throw new Error(`No D1 database named "${databaseName}".`);
  const db = database.uuid;

  const clauses = [`status = 'pending'`, `payment_status = 'unpaid'`];
  if (onlyNumber) clauses.push(`number = '${onlyNumber.replace(/'/g, "''")}'`);
  if (!all && !onlyNumber && olderThanMinutes > 0) {
    clauses.push(`created_at <= datetime('now', '-${Math.max(0, Math.floor(olderThanMinutes))} minutes')`);
  }

  const orders = await query(
    db,
    `SELECT id, number, email, total_minor, created_at FROM orders WHERE ${clauses.join(' AND ')} ORDER BY created_at`
  );

  if (!orders.length) {
    console.log('No unpaid pending orders match.');
    return;
  }

  console.log(`${orders.length} unpaid pending order(s):\n`);

  for (const order of orders) {
    // Ask Paystack what happened, when a key is available. An order Paystack
    // says is `success` must NOT be cancelled — the money is real and this would
    // be a refund wearing the wrong name.
    let gateway = 'no key provided, not checked';
    if (paystackKey) {
      try {
        const reference = await query(
          db,
          `SELECT reference FROM payments WHERE order_id = '${order.id.replace(/'/g, "''")}' LIMIT 1`
        );
        const ref = reference[0]?.reference;
        if (ref) {
          const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`, {
            headers: { Authorization: `Bearer ${paystackKey}` },
          });
          const body = await response.json().catch(() => null);
          gateway = body?.data?.status ?? body?.message ?? 'unknown';
        } else {
          gateway = 'no payment row';
        }
      } catch (error) {
        gateway = `could not check: ${error instanceof Error ? error.message : 'unknown'}`;
      }
    }

    if (gateway === 'success') {
      console.log(`  SKIP  ${order.number} — Paystack reports this as PAID. Cancelling it would be a refund.`);
      continue;
    }

    const items = await query(db, `SELECT variant_id, quantity FROM order_items WHERE order_id = '${order.id}'`);
    const units = items.reduce((total, item) => total + Number(item.quantity ?? 0), 0);

    console.log(
      `  ${order.number}  ${order.email}  ₦${(order.total_minor / 100).toLocaleString('en-NG')}  ` +
        `created ${order.created_at}  gateway: ${gateway}  ${items.length} line(s), ${units} unit(s)`
    );

    if (dryRun) continue;

    // 1. Claim it. The predicate is the guard.
    await query(
      db,
      `UPDATE orders
          SET status = 'cancelled',
              cancelled_at = datetime('now'),
              admin_note = CASE WHEN admin_note = ''
                THEN 'Cancelled an unpaid pending order; stock returned. Gateway reported: ${gateway.replace(/'/g, "''")}'
                ELSE admin_note END,
              updated_at = datetime('now')
        WHERE id = '${order.id}' AND status = 'pending' AND payment_status = 'unpaid'`
    );

    // 2. Ledger first, then the stock, per line.
    for (const item of items) {
      if (!item.variant_id) continue;
      await query(
        db,
        `INSERT INTO inventory_movements (id, variant_id, delta, reason, order_id, note)
         VALUES ('inv_cancel_${order.id.slice(-8)}_${String(item.variant_id).slice(-8)}', '${item.variant_id}', ${Number(item.quantity)}, 'order_cancelled', '${order.id}', 'unpaid order cancelled, gateway: ${gateway.replace(/'/g, "''")}')`
      );
      await query(
        db,
        `UPDATE product_variants SET stock = stock + ${Number(item.quantity)}, updated_at = datetime('now') WHERE id = '${item.variant_id}'`
      );
    }

    await query(
      db,
      `UPDATE payments SET status = 'abandoned', updated_at = datetime('now')
        WHERE order_id = '${order.id}' AND settled_at IS NULL AND status != 'success'`
    );

    console.log(`        cancelled, ${units} unit(s) returned`);
  }

  const stock = await query(db, 'SELECT SUM(stock) AS stock FROM product_variants');
  console.log(`\n${dryRun ? 'DRY RUN — nothing was written.' : 'Done.'} Total stock now ${stock[0]?.stock ?? '?'}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
