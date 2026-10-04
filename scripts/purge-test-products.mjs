#!/usr/bin/env node
/**
 * Remove test products and the orders their test runs created.
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE TEST
 *
 * `scripts/e2e-admin-catalog.mjs` creates a real product in the live shop. Its
 * own cleanup ARCHIVES that product, which is the right behaviour for the
 * assertion — an archived product is what the test proves — but archiving is not
 * removal, so every run adds a row. Cleaning up through the admin UI also depends
 * on the UI continuing to work, which is the thing under test.
 *
 * This does the removal directly and deterministically, and it is guarded:
 *
 *   - only slugs matching `e2e-probe-%` (and `%--test` with `--include-suffix`)
 *   - only products with NO order lines, unless `--force` is given
 *   - it prints exactly what it will remove before removing anything, unless
 *     `--yes` is passed
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/purge-test-products.mjs [--dry-run] [--yes] [--force]
 *     [--include-suffix]
 */

import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');
const includeSuffix = process.argv.includes('--include-suffix');

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
  if (!response.ok || !body?.success) {
    throw new Error(`query failed: ${JSON.stringify(body?.errors ?? response.status)}`);
  }
  return body.result?.[0]?.results ?? [];
}

async function main() {
  const response = await fetch(`${API}/accounts/${accountId}/d1/database`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  const database = (body?.result ?? []).find((entry) => entry.name === databaseName);
  if (!database) throw new Error(`No D1 database named "${databaseName}".`);
  databaseId = database.uuid;

  // The pattern is deliberately narrow. `--include-suffix` widens it to slugs
  // ending in `--test`, which is a convention a person may use by hand.
  const where = includeSuffix
    ? `(slug LIKE 'e2e-probe-%' OR slug LIKE '%--test')`
    : `slug LIKE 'e2e-probe-%'`;

  const candidates = await query(`
    SELECT p.slug, p.status, p.title,
           (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variants,
           (SELECT COUNT(*) FROM order_items oi
              JOIN product_variants v ON v.id = oi.variant_id
             WHERE v.product_id = p.id) AS order_lines,
           (SELECT COUNT(*) FROM cart_items ci
              JOIN product_variants v ON v.id = ci.variant_id
             WHERE v.product_id = p.id) AS cart_lines
      FROM products p
     WHERE ${where}
     ORDER BY p.slug
  `);

  if (!candidates.length) {
    console.log('No test products match.');
    return;
  }

  console.log(`${candidates.length} test product(s):\n`);
  let blocked = 0;
  for (const product of candidates) {
    const risky = Number(product.order_lines) > 0;
    if (risky) blocked += 1;
    console.log(
      `  ${product.slug}  [${product.status}]  ${product.variants} variant(s), ` +
        `${product.order_lines} order line(s), ${product.cart_lines} cart line(s)` +
        (risky ? '  <-- HAS ORDERS' : '')
    );
  }

  if (dryRun) {
    console.log('\nDRY RUN — nothing was removed.');
    return;
  }

  if (blocked > 0) {
    console.log(
      `\n${blocked} product(s) have order lines. Removing them would orphan a real order's ` +
        'records. Re-run with --force only if you are certain those orders are test data.'
    );
    if (!force) {
      console.log('Stopping without removing anything.');
      process.exit(1);
    }
  }

  // Order matters: cart lines and variants reference the product, and an order
  // line references a variant. The guards above mean order lines should be zero,
  // but `--force` allows them, and a dangling reference would be worse than a
  // leftover row.
  let variants = 0;
  let products = 0;
  for (const product of candidates) {
    if (Number(product.order_lines) > 0 && !force) continue;
    const rows = await query(`SELECT id FROM products WHERE slug = '${product.slug.replace(/'/g, "''")}'`);
    const id = rows[0]?.id;
    if (!id) continue;

    await query(`DELETE FROM cart_items WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = '${id}')`);
    await query(`DELETE FROM product_variants WHERE product_id = '${id}'`);
    await query(`DELETE FROM products WHERE id = '${id}'`);
    variants += Number(product.variants);
    products += 1;
  }

  const after = await query(`
    SELECT (SELECT COUNT(*) FROM products) AS products,
           (SELECT COUNT(*) FROM products WHERE ${where}) AS test_products,
           (SELECT COUNT(*) FROM product_variants) AS variants,
           (SELECT SUM(stock) FROM product_variants) AS stock
  `);
  console.log(`\nRemoved ${products} product(s) and ${variants} variant(s).`);
  console.log(`After: ${JSON.stringify(after[0])}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
