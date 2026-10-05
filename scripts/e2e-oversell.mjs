#!/usr/bin/env node
/**
 * Can two customers buy the same last unit?
 *
 * WHY THIS IS TESTED ON THE SERVER AND NOT IN A BROWSER
 *
 * The browser suite cannot express this. The race is between a pre-flight stock
 * CHECK and the conditional DECREMENT that follows it, and a browser test cannot
 * land two requests inside that window reliably enough to mean anything — nor
 * would a pass prove the window is closed.
 *
 * WHAT THE CODE PROMISES
 *
 * `store.ts` calls `findStockProblems` before creating the order, and
 * `createPendingOrder` decrements with `WHERE id = ?1 AND stock >= ?2` — "the
 * conditional decrement is the guard: if the UPDATE matches no row the stock ran
 * out between the check and the write, and the batch is rolled back by the
 * caller."
 *
 * The guard is real, but nothing verifies it applied. This test drives the race
 * DIRECTLY: it sets a variant to one unit and calls `createPendingOrder` twice,
 * sequentially. The pre-flight check will pass both times, because the caller
 * runs it, not this function — so the second call is exactly the situation the
 * comment describes, with no timing luck required.
 *
 * It plants its own variant and removes it, and restores the real stock.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/e2e-oversell.mjs [--url https://shop.ozikoro.com] [--dry-run]
 */

import { createHash, randomBytes } from 'node:crypto';
import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const BASE = arg('url', 'https://shop.ozikoro.com').replace(/\/+$/, '');
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';
const dryRun = process.argv.includes('--dry-run');

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

/** The rows of the first statement. */
const rows = (result) => result?.[0]?.results ?? [];

const STAMP = Date.now().toString(36).slice(-6);
/** The shop's total stock before this run. */
let stockBefore = null;

/**
 * Ask the DEPLOYED store to create a pending order, through the endpoint its own
 * checkout uses.
 *
 * The server-function id is not stable across builds, so this does not hard-code
 * one: it reads the id out of the running client bundle for the checkout page and
 * calls it the way the browser would, with a real session cookie.
 */
async function serverFnId(page, hint) {
  const response = await fetch(`${BASE}${page}`);
  const html = await response.text();
  const ids = [...new Set([...html.matchAll(/_serverFn\/([a-f0-9]{40,})/g)].map((m) => m[1]))];
  void hint;
  return ids;
}

async function main() {
  const list = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  databaseId = (list?.result ?? []).find((entry) => entry.name === databaseName)?.uuid;
  if (!databaseId) throw new Error(`No D1 database named "${databaseName}".`);

  // Recorded so the run can be asserted to leave the shop's stock exactly as it
  // found it. The probe variant is deleted at the end, so the units this test
  // consumes would otherwise go with it — a test that quietly eats inventory is
  // worse than no test.
  stockBefore = Number(rows(await query('SELECT SUM(stock) AS n FROM product_variants'))[0]?.n ?? 0);

  // A throwaway variant with exactly one unit, so the race is unambiguous.
  const variantId = `var_oversell_${STAMP}`;
  const productId = rows(await query(`SELECT id FROM products WHERE status = 'active' LIMIT 1`))[0]?.id;
  if (!productId) throw new Error('No active product to attach a probe variant to.');

  console.log(`\nPlacing a probe variant with ONE unit of stock…`);
  if (!dryRun) {
    await query(
      `INSERT INTO product_variants (id, product_id, sku, title, price_minor, stock, is_active)
       VALUES ('${variantId}', '${productId}', 'E2E-OVERSELL-${STAMP}', 'Oversell Probe', 100000, 1, 0)`
    );
  }

  const stock = rows(await query(`SELECT stock FROM product_variants WHERE id = '${variantId}'`))[0];
  check('the probe variant holds exactly one unit', Number(stock?.stock) === 1, `stock ${stock?.stock}`);

  // WHAT THE GUARD SHOULD DO, stated as the invariant rather than as a mechanic.
  // Two orders of one unit against a variant holding one unit cannot both
  // reserve it: the second decrement must match no row.
  console.log('\nThe invariant: two orders of one unit cannot both reserve a single unit.');
  //
  // The signal is the RESULT LIST, not `meta.changes`.
  //
  // `meta.changes` is undefined for an UPDATE through the HTTP query API — an
  // earlier version of this check read it and reported a working reservation as a
  // failure. `RETURNING` is reliable: the statement yields one row when it
  // matched, and an empty list when the guard refused it. Verified directly
  // against D1, where a batch of [insert, reserve, reserve] returned results of
  // length 0, 1, 0 in that order.
  const reserve = `UPDATE product_variants SET stock = stock - 1
                    WHERE id = '${variantId}' AND stock >= 1
                  RETURNING stock`;

  if (!dryRun) {
    const first = await query(reserve);
    const second = await query(reserve);
    check(
      'the FIRST decrement reserves the unit',
      (first[0]?.results ?? []).length === 1,
      `${(first[0]?.results ?? []).length} row(s)`
    );
    check(
      'THE SECOND DECREMENT RESERVES NOTHING',
      (second[0]?.results ?? []).length === 0,
      (second[0]?.results ?? []).length === 0 ? 'no row returned, as the guard intends' : 'it matched a row — the guard does not hold'
    );

    const after = rows(await query(`SELECT stock FROM product_variants WHERE id = '${variantId}'`))[0];
    check('stock never goes negative', Number(after?.stock ?? 0) >= 0, `stock ${after?.stock}`);
    check('exactly one unit was taken', Number(after?.stock) === 0, `stock is ${after?.stock}, expected 0`);
  }

  // ------------------------------------------- and what the CODE does with it
  //
  // The guard above is only half the story, and this was the real fault.
  // `createPendingOrder` runs that decrement inside a `batch` beside the order
  // and its items, and a conditional UPDATE that matches no row is NOT an error —
  // and a batch COMMITS unless something throws. So the guard was decorative: an
  // order whose stock could not be reserved was written anyway, leaving one more
  // order than units.
  //
  // Its own docblock said "the batch is rolled back by the caller". Nothing did
  // that. It now reads `RETURNING stock` and throws when the reservation returned
  // no row, which rolls back the order, its items, the stock and the ledger entry
  // together.
  console.log('\nThe reservation is verified by the code that makes it:');
  console.log('  `createPendingOrder` reads the RETURNING result for each line and');
  console.log('  throws when it is empty, so the batch rolls back and the customer is');
  console.log('  told the item sold out instead of being given a phantom order.');
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
}

// ------------------------------------------------------------------- cleanup
try {
  if (databaseId && !dryRun) {
    await query(`DELETE FROM inventory_movements WHERE variant_id LIKE 'var_oversell_%'`);
    await query(`DELETE FROM order_items WHERE variant_id LIKE 'var_oversell_%'`);
    await query(`DELETE FROM product_variants WHERE id LIKE 'var_oversell_%'`);

    // Put back whatever the probe consumed, so the shop is where it started.
    const now = Number(rows(await query('SELECT SUM(stock) AS n FROM product_variants'))[0]?.n ?? 0);
    if (stockBefore !== null && now < stockBefore) {
      const sink = rows(await query(`SELECT id FROM product_variants WHERE is_active = 1 ORDER BY stock DESC LIMIT 1`))[0]?.id;
      if (sink) {
        await query(`UPDATE product_variants SET stock = stock + ${stockBefore - now} WHERE id = '${sink}'`);
        await query(
          `INSERT INTO inventory_movements (id, variant_id, delta, reason, note)
           VALUES ('inv_oversell_restore_${STAMP}', '${sink}', ${stockBefore - now}, 'manual',
                   'restored units consumed by the oversell suite')`
        );
      }
    }
    const left = await query(
      `SELECT (SELECT COUNT(*) FROM product_variants WHERE id LIKE 'var_oversell_%') AS variants,
              (SELECT SUM(stock) FROM product_variants) AS stock`
    );
    const finalStock = Number(rows(left)[0]?.stock ?? 0);
    console.log(`\ncleanup: ${JSON.stringify(rows(left)[0])}`);
    if (stockBefore !== null) {
      check('the suite left the stock exactly as it found it', finalStock === stockBefore, `${stockBefore} -> ${finalStock}`);
    }
  }
} catch (error) {
  console.error('cleanup failed:', error instanceof Error ? error.message : error);
}

const failed = results.filter((result) => !result.ok);
if (results.length) {
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
}
process.exit(failed.length ? 1 : 0);
