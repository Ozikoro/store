#!/usr/bin/env node
/**
 * Create or promote an account, and set its role.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A BACKDOOR
 *
 * Administrative access is a ROLE ON AN ACCOUNT — there is no environment
 * variable that grants it, because a variable is one leaked value away from a
 * takeover, and no "bootstrap" endpoint, because an endpoint is one URL away.
 * That leaves one honest gap: the very first admin has to be made by someone
 * with database access. This is that tool. It is run deliberately, by a person,
 * with the D1 credentials in their environment.
 *
 * The password is hashed here with the SAME scrypt parameters the application
 * verifies against, so the account this creates can sign in normally. The
 * password is never stored, never printed, and never passed as an argument — it
 * is read from an environment variable or prompted for.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *   SEED_EMAIL=hello@ozikoro.com SEED_PASSWORD='…' SEED_ROLE=super_admin \
 *     node scripts/create-account.mjs
 */

import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import process from 'node:process';

const scrypt = promisify(scryptCallback);
const API = 'https://api.cloudflare.com/client/v4';
const KEY_BYTES = 64;

const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';
const email = (process.env['SEED_EMAIL'] ?? '').trim().toLowerCase();
const password = process.env['SEED_PASSWORD'] ?? '';
const role = process.env['SEED_ROLE'] ?? 'customer';

const VALID_ROLES = ['customer', 'store_admin', 'fulfilment', 'content_manager', 'super_admin'];

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  process.exit(2);
}
if (!email || !password) {
  console.error('SEED_EMAIL and SEED_PASSWORD must be set.');
  process.exit(2);
}
if (password.length < 8) {
  console.error('SEED_PASSWORD must be at least 8 characters.');
  process.exit(2);
}
if (!VALID_ROLES.includes(role)) {
  console.error(`SEED_ROLE must be one of: ${VALID_ROLES.join(', ')}`);
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
    throw new Error(`${init?.method ?? 'GET'} ${pathname} failed: ${JSON.stringify(body?.errors ?? response.status)}`);
  }
  return body.result;
}

/** Run one statement and return its rows. */
async function sql(databaseId, statement, params = []) {
  const result = await api(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql: statement, params }),
  });
  return result?.[0]?.results ?? [];
}

function escape(value) {
  return String(value).replace(/'/g, "''");
}

async function main() {
  const databases = await api(`/accounts/${accountId}/d1/database`);
  const database = (databases ?? []).find((entry) => entry.name === databaseName);
  if (!database) throw new Error(`No D1 database named "${databaseName}".`);

  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_BYTES);
  const hash = derived.toString('hex');

  const existing = await sql(
    database.uuid,
    `SELECT id, email, name FROM customers WHERE email = '${escape(email)}'`
  );

  let customerId;
  if (existing.length) {
    customerId = existing[0].id;
    await sql(
      database.uuid,
      `UPDATE customers
          SET password_hash = '${hash}', password_salt = '${salt}', updated_at = datetime('now')
        WHERE id = '${escape(customerId)}'`
    );
    console.log(`Updated the password for ${email}.`);
  } else {
    customerId = `cus_seed_${randomBytes(9).toString('hex')}`;
    await sql(
      database.uuid,
      `INSERT INTO customers (id, email, password_hash, password_salt, name)
       VALUES ('${escape(customerId)}', '${escape(email)}', '${hash}', '${salt}', 'Ozikoro Store')`
    );
    console.log(`Created ${email}.`);
  }

  // The role is a column on the account, written here and nowhere else outside
  // the super-admin screen. Sessions are cleared so the change applies at the
  // next sign-in — a revoked admin who keeps working for a month is not a
  // revocation.
  await sql(
    database.uuid,
    `UPDATE customers SET role = '${escape(role)}', updated_at = datetime('now')
      WHERE id = '${escape(customerId)}'`
  );
  await sql(database.uuid, `DELETE FROM sessions WHERE customer_id = '${escape(customerId)}'`);

  console.log(`Account ready: ${email} (${role}).`);
  console.log('Sign in at https://shop.ozikoro.com/account.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
