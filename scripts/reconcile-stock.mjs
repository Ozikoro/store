#!/usr/bin/env node
/**
 * Does the inventory ledger agree with the stock on the shelf?
 *
 * WHY THIS MATTERS
 *
 * Every change to stock writes an `inventory_movements` row: the opening seed, a
 * sale, a cancellation, a refund restock, a manual adjustment. The table and the
 * `product_variants.stock` column are two records of the same fact, and when they
 * disagree, one of them is lying about how much there is to sell.
 *
 * That is not hypothetical. A test suite was destroying seven units of real stock
 * on every run — it created a variant with stock, set that stock to zero, then
 * deleted the product — and nothing noticed, because nothing compared the two
 * records. Fifty-six units went missing across eight runs before anyone looked.
 *
 * WHAT IT CHECKS
 *
 *   1. Per variant: `SUM(movements.delta)` equals `stock`.
 *   2. In total: the ledger's sum equals the shelf's sum.
 *   3. Negative stock, which the CHECK constraint should make impossible.
 *
 * A mismatch is REPORTED, not repaired. Stock is money, and a script that
 * silently "fixes" a disagreement destroys the evidence of which record was
 * wrong. `--verbose` lists every variant.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/reconcile-stock.mjs [--verbose] [--ignore-test-movements]
 */

import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';
const verbose = process.argv.includes('--verbose');

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  process.exit(2);
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

async function main() {
  const list = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  const database = (list?.result ?? []).find((entry) => entry.name === databaseName);
  if (!database) throw new Error(`No D1 database named "${databaseName}".`);
  databaseId = database.uuid;

  const rows = await query(`
    SELECT
      v.id,
      v.sku,
      p.slug,
      v.stock,
      v.is_active,
      COALESCE((SELECT SUM(m.delta) FROM inventory_movements m WHERE m.variant_id = v.id), 0) AS ledger
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    ORDER BY p.slug, v.sku
  `);

  const mismatches = [];
  let shelfTotal = 0;
  let ledgerTotal = 0;
  const negative = [];

  for (const row of rows) {
    const stock = Number(row.stock);
    const ledger = Number(row.ledger);
    shelfTotal += stock;
    ledgerTotal += ledger;
    if (stock < 0) negative.push(row);
    const agrees = stock === ledger;
    if (!agrees) mismatches.push({ ...row, stock, ledger });
    if (verbose || !agrees) {
      console.log(
        `  ${agrees ? 'ok  ' : 'DIFF'} ${String(row.sku).padEnd(14)} ${String(row.slug).slice(0, 26).padEnd(28)}` +
          ` stock ${String(stock).padStart(5)}  ledger ${String(ledger).padStart(5)}`
      );
    }
  }

  const byReason = await query(
    `SELECT reason, SUM(delta) AS net, COUNT(*) AS n FROM inventory_movements GROUP BY reason ORDER BY reason`
  );

  console.log(`\nvariants checked : ${rows.length}`);
  console.log(`stock on the shelf: ${shelfTotal}`);
  console.log(`movements in total: ${ledgerTotal}`);
  console.log('\nby reason:');
  for (const reason of byReason) {
    console.log(`  ${String(reason.reason).padEnd(18)} net ${String(reason.net).padStart(6)}  in ${reason.n} row(s)`);
  }

  const problems = mismatches.length + negative.length;
  console.log('');
  if (negative.length) {
    console.log(`${negative.length} variant(s) have NEGATIVE stock, which the schema forbids:`);
    for (const row of negative) console.log(`  ${row.sku}: ${row.stock}`);
  }
  if (mismatches.length) {
    console.log(`${mismatches.length} variant(s) disagree with their ledger:`);
    for (const row of mismatches) {
      console.log(`  ${row.sku}: shelf ${row.stock}, ledger ${row.ledger} (difference ${row.stock - row.ledger})`);
    }
    console.log(
      '\nThis is not repaired automatically: stock is money, and overwriting one record\n' +
        'would destroy the evidence of which one was wrong.'
    );
  }
  if (!problems) console.log('The ledger and the shelf agree, variant by variant.');
  process.exit(problems ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
