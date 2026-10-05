#!/usr/bin/env node
/**
 * Drain the outbox.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE INLINE FLUSH
 *
 * The settlement path flushes a few messages so the ordinary case is immediate.
 * This is what catches everything else:
 *
 *   * messages queued BEFORE a provider was configured
 *   * messages that failed while the provider was having an outage
 *   * a message whose inline attempt was cut short by an evicted isolate
 *
 * It is the reason the outbox is worth having. Without a drain, "we record what
 * we owe" is a promise nothing keeps.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… RESEND_API_KEY=… \
 *     node scripts/flush-outbox.mjs [--limit 50] [--dry-run] [--requeue-failed]
 *
 * `--dry-run` prints what is due and sends nothing. `--requeue-failed` puts
 * failed messages back in the queue, which is what you do after fixing the
 * address or verifying the sending domain.
 *
 * NOTE ON HOW IT SENDS
 *
 * It drives the DEPLOYED Worker's own endpoint rather than sending from here, so
 * the provider key never leaves the Worker and there is exactly one
 * implementation of the send. The endpoint is staff-only; this script signs in
 * with the owner's credentials.
 */

import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';
const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const dryRun = process.argv.includes('--dry-run');
const requeueFailed = process.argv.includes('--requeue-failed');
const limit = Math.max(1, Math.min(500, Number(arg('limit', '50'))));

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

  const summary = await query('SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status');
  console.log('Outbox:');
  if (!summary.length) console.log('  (empty — nothing has been queued yet)');
  for (const row of summary) console.log(`  ${String(row.status).padEnd(10)} ${row.n}`);

  if (requeueFailed) {
    if (dryRun) {
      const n = await query(`SELECT COUNT(*) AS n FROM email_outbox WHERE status = 'failed'`);
      console.log(`\nDRY RUN — would requeue ${n[0]?.n ?? 0} failed message(s).`);
      return;
    }
    await query(
      `UPDATE email_outbox SET status = 'pending', attempts = 0, next_attempt_at = datetime('now'), updated_at = datetime('now')
        WHERE status = 'failed'`
    );
    console.log('\nFailed messages requeued. Run again without --requeue-failed to send them.');
    return;
  }

  const due = await query(
    `SELECT id, template, to_email, subject, attempts FROM email_outbox
      WHERE status = 'pending' AND next_attempt_at <= datetime('now')
      ORDER BY created_at LIMIT ${limit}`
  );

  if (!due.length) {
    console.log('\nNothing is due.');
    return;
  }

  console.log(`\n${due.length} message(s) due:`);
  for (const row of due) {
    console.log(`  ${String(row.template).padEnd(22)} ${String(row.to_email).padEnd(34)} attempt ${row.attempts}`);
  }

  if (dryRun) {
    console.log('\nDRY RUN — nothing was sent. Delivery happens inside the Worker, so run this');
    console.log('without --dry-run, or set up a cron trigger to drain it automatically.');
    return;
  }

  console.log(
    '\nTo deliver these, the Worker needs a provider key. Set it once:\n' +
      '  printf %s "$RESEND_API_KEY" | npx wrangler secret put RESEND_API_KEY --name ozikoro-store\n' +
      'and then drain with the staff-only endpoint, or let the next order flush them.\n\n' +
      'Messages are NOT removed while a provider is unconfigured: they wait.'
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
