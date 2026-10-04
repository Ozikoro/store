#!/usr/bin/env node
/**
 * Apply the store's migrations to Cloudflare D1.
 *
 * D1 exposes a query endpoint that runs SQL; there is no migration ledger, so
 * these migrations are written to be IDEMPOTENT — every CREATE is
 * `IF NOT EXISTS` and every INSERT is `ON CONFLICT DO NOTHING`. That is why
 * running this twice is safe, and why it does not need to remember what it has
 * already done.
 *
 * Credentials come from the environment. Nothing here prints a token.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *   node scripts/d1-migrate.mjs [--database ozikoro-store] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = arg('database', 'ozikoro-store');
const dryRun = process.argv.includes('--dry-run');

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  process.exit(2);
}

async function api(pathname, init) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const detail = body?.errors ? JSON.stringify(body.errors) : `HTTP ${response.status}`;
    throw new Error(`${init?.method ?? 'GET'} ${pathname} failed: ${detail}`);
  }
  return body.result;
}

async function resolveDatabaseId() {
  const databases = await api(`/accounts/${accountId}/d1/database`);
  const match = (databases ?? []).find((database) => database.name === databaseName);
  if (!match) {
    throw new Error(
      `No D1 database named "${databaseName}". Create it with:\n` +
        `  curl -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \\\n` +
        `    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database" \\\n` +
        `    -d '{"name":"${databaseName}"}'`
    );
  }
  return match.uuid;
}

async function runSql(databaseId, sql) {
  const result = await api(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });
  return result;
}

/**
 * Split a migration file into individually runnable statements.
 *
 * Naive `split(';')` would break on a semicolon inside a string literal, and
 * these migrations have product descriptions containing them. So the split
 * tracks single-quoted strings and `--` line comments.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  let inComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (inComment) {
      current += char;
      if (char === '\n') inComment = false;
      continue;
    }
    if (!inString && char === '-' && next === '-') {
      inComment = true;
      current += char;
      continue;
    }
    if (char === "'") {
      // A doubled quote inside a literal is an escaped quote, not a terminator.
      if (inString && next === "'") {
        current += "''";
        index += 1;
        continue;
      }
      inString = !inString;
      current += char;
      continue;
    }
    if (!inString && char === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }
    current += char;
  }
  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

async function main() {
  const migrationsDir = path.join(process.cwd(), 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const databaseId = await resolveDatabaseId();
  console.log(`Database  ${databaseName} (${databaseId})`);
  console.log(`Migrations ${files.length} file(s)\n`);

  let applied = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = splitStatements(sql);
    console.log(`${file} — ${statements.length} statement(s)`);

    for (const [index, statement] of statements.entries()) {
      const label = statement.replace(/\s+/g, ' ').slice(0, 70);
      if (dryRun) {
        console.log(`  [dry] ${index + 1}. ${label}`);
        continue;
      }
      try {
        await runSql(databaseId, `${statement};`);
        applied += 1;
        console.log(`  ok   ${index + 1}. ${label}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, so a
        // re-run of a migration that adds a column reports a duplicate. That is
        // the desired end state, not a failure — treat it as one, or this script
        // cries wolf every time it is run twice.
        if (/duplicate column name|already exists/i.test(message)) {
          skipped += 1;
          console.log(`  skip ${index + 1}. ${label} (already applied)`);
          continue;
        }
        failed += 1;
        console.error(`  FAIL ${index + 1}. ${label}`);
        console.error(`       ${message}`);
      }
    }
  }

  console.log(`\nApplied ${applied} statement(s), ${skipped} already applied, ${failed} failure(s).`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
