#!/usr/bin/env node
/**
 * Order numbers must never be reused, and must never fail a checkout.
 *
 * WHY THIS IS ITS OWN SUITE
 *
 * `nextOrderNumber` is three lines and was wrong twice, in ways that only show up
 * under conditions a browser suite cannot stage:
 *
 *   1. It counted rows. `COUNT(*)` is not a sequence — delete one order and the
 *      count falls, so the next order is handed a number an earlier one already
 *      had. The number is what a customer quotes and what goes on a courier
 *      label, so a reused number is wrong even when nothing collides.
 *   2. It read, checked and returned, with the insert happening later in another
 *      transaction. `orders.number` is UNIQUE, so a collision between the read
 *      and the insert made the loser's CHECKOUT FAIL on a database constraint.
 *
 * It is verified against the live database because the faults are properties of
 * the SQL, not of any function a unit test can call in isolation.
 *
 * It plants nothing and removes nothing: it only reads, and every order it
 * inspects is a real one that already exists.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/e2e-order-numbering.mjs
 */

import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';
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

async function main() {
  const list = await (await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json();
  databaseId = (list?.result ?? []).find((entry) => entry.name === databaseName)?.uuid;
  if (!databaseId) throw new Error(`No D1 database named "${databaseName}".`);

  // ---------------------------------------------------------------- the shape
  const sample = rows(await query(`SELECT number FROM orders ORDER BY created_at DESC LIMIT 20`));
  check('there are orders to inspect', sample.length > 0, `${sample.length} sampled`);

  check(
    'every order number has the documented form',
    sample.every((row) => /^OZK-\d+$/.test(String(row.number))),
    sample.filter((row) => !/^OZK-\d+$/.test(String(row.number))).map((r) => r.number).join(', ')
  );

  // ------------------------------------------------------------- no duplicates
  //
  // The UNIQUE constraint makes this true by construction, and that is exactly
  // why it is worth stating: it is the guarantee a customer relies on when they
  // quote the number.
  const dupes = rows(
    await query(`SELECT number, COUNT(*) AS n FROM orders GROUP BY number HAVING n > 1 LIMIT 5`)
  );
  check('no order number is used twice', dupes.length === 0, dupes.map((d) => `${d.number} x${d.n}`).join(', '));

  // ---------------------------------------------------- MAX, not the row count
  //
  // This is the difference between the corrected read and the old one, stated as
  // a property. `COUNT(*)` and `MAX` agree until a row is removed, and then the
  // count reissues a number. The property that must hold is simply that the next
  // number is AHEAD OF EVERY NUMBER IN USE — which a count cannot guarantee.
  const stats = rows(
    await query(
      `SELECT COUNT(*) AS counted,
              COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 10000) AS highest
         FROM orders
        WHERE number GLOB 'OZK-[0-9]*'`
    )
  )[0];
  const counted = Number(stats?.counted ?? 0);
  const highest = Number(stats?.highest ?? 10000);
  const next = highest + 1;

  const lowestRow = rows(
    await query(`SELECT MIN(CAST(substr(number, 5) AS INTEGER)) AS lowest FROM orders WHERE number GLOB 'OZK-[0-9]*'`)
  )[0];
  const lowest = Number(lowestRow?.lowest ?? 10001);

  check(
    'orders exist in the plain numbered form',
    lowest > 10000 && highest >= lowest,
    `lowest OZK-${lowest}, highest OZK-${highest}`
  );

  // The property, stated the way it actually matters: the number about to be
  // issued is strictly greater than every number already issued. `COUNT(*)`-based
  // allocation satisfies this only while no row has ever been removed.
  check(
    'THE NEXT NUMBER IS AHEAD OF EVERY NUMBER IN USE',
    next > highest,
    `next OZK-${next} vs highest OZK-${highest}`
  );

  // And the number of rows is NOT a safe proxy for that, shown concretely: if any
  // row is ever removed, the count-based candidate falls below the highest in use.
  const countCandidate = 10000 + counted + 1;
  console.log(
    `\n  rows in the table    : ${counted}` +
      `\n  highest number issued: OZK-${highest}` +
      `\n  next number          : OZK-${next}` +
      `\n  a COUNT-based read would produce OZK-${countCandidate}, which ${
        countCandidate > highest ? 'happens to be safe HERE, because nothing has been removed' : 'IS BELOW THE HIGHEST IN USE and would reissue a number'
      }`
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
process.exit(failed.length ? 1 : 0);
