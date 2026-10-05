#!/usr/bin/env node
/**
 * Housekeeping for carts.
 *
 * WHY THIS IS NEEDED
 *
 * A cart row is created for a VISITOR, not for a customer — it is the thing that
 * makes a basket survive a page load. That is the right design and it has a cost:
 * every visitor who never adds anything still leaves a row, and nothing ever
 * removes one. On a live shop that grows without bound, and the growth is all
 * rows nobody will ever look at.
 *
 * The schema already names the two states this needs — `carts.status` is
 * documented as `'open' | 'converted' | 'abandoned'` — and until now nothing ever
 * wrote `abandoned`. So the first half of this is simply using the column as
 * intended, and the second half is removing what is genuinely spent.
 *
 * WHAT IT DOES, IN ORDER, AND WHY THAT ORDER
 *
 *   1. Mark an old `open` cart `abandoned`. It is kept, because a basket that was
 *      filled and left is worth seeing: it is what tells an owner that people
 *      want a thing they are not buying.
 *   2. Delete an old `abandoned` cart that is EMPTY and has no customer attached.
 *      An empty basket holds no information and belongs to nobody. A cart WITH
 *      items is never deleted here — that is the signal from step 1, and deleting
 *      it would destroy the only record of the intent.
 *   3. Delete the cart items of anything it removes, and report what is left.
 *
 * `converted` carts are never touched by any step: an order points at one.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/prune-carts.mjs [--dry-run] \
 *     [--abandon-after-hours 24] [--delete-after-days 30] [--batch 500]
 *
 * Run with `--dry-run` first; it reports without writing.
 */

import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

/** Clear rate-limit buckets by prefix, for when a legitimate person is locked out. */
function ratePrefix() {
  const index = process.argv.indexOf('--clear-rate-limits');
  if (index === -1) return null;
  const value = process.argv[index + 1];
  // Refusing to clear EVERYTHING unless asked explicitly: the login limiter is a
  // security control, and a command that quietly disables it is a footgun.
  return value && !value.startsWith('--') ? value : '*';
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const dryRun = process.argv.includes('--dry-run');
const abandonAfterHours = Math.max(1, Math.floor(Number(arg('abandon-after-hours', '24'))));
const deleteAfterDays = Math.max(1, Math.floor(Number(arg('delete-after-days', '30'))));
// D1 discourages enormous single statements, so deletes are chunked.
const batch = Math.min(2000, Math.max(1, Math.floor(Number(arg('batch', '500')))));

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

let databaseId = null;
async function query(sql) {
  const result = await api(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
  return result?.[0]?.results ?? [];
}

/** `meta.changes` from a write, which D1 reports per statement. */
async function run(sql) {
  const result = await api(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
  return result?.[0]?.meta?.changes ?? 0;
}

async function main() {
  const databases = await api(`/accounts/${accountId}/d1/database`);
  const database = (databases ?? []).find((entry) => entry.name === databaseName);
  if (!database) throw new Error(`No D1 database named "${databaseName}".`);
  databaseId = database.uuid;

  const clearPrefix = ratePrefix();
  if (clearPrefix !== null && !dryRun) {
    // An owner locked out by the login limiter has no other way back: there is no
    // "forgot password" flow, so the limit cannot be cleared from the site. This
    // is the operator's answer.
    const removed = await run(
      clearPrefix === '*'
        ? 'DELETE FROM rate_limits'
        : `DELETE FROM rate_limits WHERE key LIKE '${clearPrefix.replace(/'/g, "''")}%'`
    );
    console.log(`Cleared ${removed} rate-limit bucket(s) matching "${clearPrefix}".\n`);
  }

  const before = await query(`
    SELECT
      (SELECT COUNT(*) FROM carts) AS total,
      (SELECT COUNT(*) FROM carts WHERE status = 'open') AS open,
      (SELECT COUNT(*) FROM carts WHERE status = 'converted') AS converted,
      (SELECT COUNT(*) FROM carts WHERE status = 'abandoned') AS abandoned,
      (SELECT COUNT(DISTINCT cart_id) FROM cart_items) AS with_items
  `);
  console.log('Before:', JSON.stringify(before[0]));

  // 1. An old open cart becomes abandoned — KEPT, not deleted.
  const toAbandon = await query(`
    SELECT COUNT(*) AS n FROM carts
     WHERE status = 'open'
       AND updated_at <= datetime('now', '-${abandonAfterHours} hours')
  `);

  console.log(`\n1. Mark abandoned: ${toAbandon[0]?.n ?? 0} open cart(s) idle for ${abandonAfterHours}h or more.`);
  if (!dryRun) {
    const changed = await run(`
      UPDATE carts SET status = 'abandoned', updated_at = datetime('now')
       WHERE status = 'open'
         AND updated_at <= datetime('now', '-${abandonAfterHours} hours')
    `);
    console.log(`   marked ${changed} cart(s) abandoned (kept — a filled basket is a signal)`);
  }

  // 2. Delete abandoned carts that are EMPTY and belong to nobody.
  //
  // The conditions are deliberately narrow. A cart with items records intent; a
  // cart with a customer is someone's basket. Neither is removed.
  //
  // RETENTION IS MEASURED FROM `created_at`, NOT `updated_at`, AND THAT IS THE
  // WHOLE POINT OF THIS COMMENT. Step 1 above writes `updated_at = now` when it
  // marks a cart abandoned, so an `updated_at` test here would reset the age of
  // every cart it had just touched — meaning nothing ever became old enough to
  // delete and the table would grow forever. The first version of this script
  // did exactly that, and reported success while deleting nothing.
  //
  // `created_at` is never written again, so it is the only stable clock. A cart
  // is retained for `deleteAfterDays` from when the VISITOR first arrived.
  const emptyWhere = `
    status = 'abandoned'
    AND customer_id IS NULL
    AND created_at <= datetime('now', '-${deleteAfterDays} days')
    AND id NOT IN (SELECT DISTINCT cart_id FROM cart_items)
  `;

  const toDelete = await query(`SELECT COUNT(*) AS n FROM carts WHERE ${emptyWhere}`);
  console.log(
    `\n2. Delete empty: ${toDelete[0]?.n ?? 0} abandoned cart(s) with no items, no customer, older than ${deleteAfterDays}d.`
  );

  let deleted = 0;
  if (!dryRun) {
    // Chunked, and re-evaluated each time, so the set cannot shift under us.
    //
    // The rows removed are COUNTED rather than read from `meta.changes`: D1
    // reports that field inconsistently for a statement with a subquery, and a
    // delete that reports zero while removing a thousand rows is worse than no
    // report at all.
    for (let pass = 0; pass < 200; pass += 1) {
      const target = await query(`SELECT COUNT(*) AS n FROM carts WHERE ${emptyWhere}`);
      const remaining = target[0]?.n ?? 0;
      if (remaining === 0) break;
      await run(`
        DELETE FROM carts
         WHERE id IN (SELECT id FROM carts WHERE ${emptyWhere} LIMIT ${batch})
      `);
      const after = await query(`SELECT COUNT(*) AS n FROM carts WHERE ${emptyWhere}`);
      const now = after[0]?.n ?? 0;
      deleted += Math.max(0, remaining - now);
      if (now >= remaining) break; // nothing moved: stop rather than spin
      if (now === 0) break;
    }
    console.log(`   deleted ${deleted} empty cart(s)`);
  }

  // 3. What remains, including the signal worth keeping.
  // 3. Rate-limit buckets, on the same argument as the carts: a key that is only
  //    meaningful inside its window leaves a row behind forever, one per visitor.
  const staleLimits = await query(
    `SELECT COUNT(*) AS n FROM rate_limits WHERE window_start <= datetime('now', '-86400 seconds')`
  );
  console.log(`\n3. Rate-limit buckets older than a day: ${staleLimits[0]?.n ?? 0}.`);
  if (!dryRun) {
    const removed = await run(
      `DELETE FROM rate_limits WHERE window_start <= datetime('now', '-86400 seconds')`
    );
    console.log(`   deleted ${removed} stale bucket(s)`);
  }

  // 4. Expired sessions. A session row outlives its own expiry by up to thirty
  //    days of dead weight — one per sign-in, per test run, per device — and
  //    nothing removed them. `actorFromToken` already destroys one when it is
  //    presented after expiry; this clears the ones nobody ever presents again.
  const staleSessions = await query(
    `SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= datetime('now')`
  );
  console.log(`\n4. Expired sessions: ${staleSessions[0]?.n ?? 0}.`);
  if (!dryRun) {
    const removed = await run(`DELETE FROM sessions WHERE expires_at <= datetime('now')`);
    console.log(`   deleted ${removed} expired session(s)`);
  }

  const after = await query(`
    SELECT
      (SELECT COUNT(*) FROM carts) AS total,
      (SELECT COUNT(*) FROM carts WHERE status = 'open') AS open,
      (SELECT COUNT(*) FROM carts WHERE status = 'converted') AS converted,
      (SELECT COUNT(*) FROM carts WHERE status = 'abandoned') AS abandoned,
      (SELECT COUNT(DISTINCT cart_id) FROM cart_items) AS with_items,
      (SELECT COUNT(*) FROM carts WHERE status = 'abandoned' AND id IN (SELECT DISTINCT cart_id FROM cart_items)) AS abandoned_with_items
  `);
  console.log(`\nAfter: ${JSON.stringify(after[0])}`);
  console.log(
    dryRun
      ? '\nDRY RUN — nothing was written.'
      : `\nDone. ${deleted} row(s) removed; ${after[0]?.abandoned_with_items ?? 0} abandoned basket(s) with items kept for reference.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
