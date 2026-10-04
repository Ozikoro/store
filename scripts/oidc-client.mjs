#!/usr/bin/env node
/**
 * Register an OIDC client.
 *
 * There is no dynamic registration endpoint, deliberately: every client is
 * somewhere an account's identity can be sent, and "anyone may register" is not
 * a property an identity provider should have. Registering is an operator
 * action, and this is the operator's tool.
 *
 * The client secret is shown ONCE. Only its SHA-256 is stored, so it cannot be
 * recovered — if it is lost, rotate by registering again and deactivating the
 * old client. It must live in the client's SERVER environment. The previous
 * bridge between two Ozikoro sites was deleted because its shared secret was a
 * `VITE_`-prefixed variable, which inlined it into the browser bundle and let
 * anyone mint accounts; that mistake is why this message is this long.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     node scripts/oidc-client.mjs register --name "Ozikoro Archive" \
 *       --redirect https://ozikoro.com/oidc/callback \
 *       --post-logout https://ozikoro.com/ \
 *       [--public]
 *   node scripts/oidc-client.mjs list
 *   node scripts/oidc-client.mjs deactivate --client-id ozk_…
 */

import { randomBytes, createHash } from 'node:crypto';
import process from 'node:process';

const API = 'https://api.cloudflare.com/client/v4';
const ISSUER = (process.env['STORE_ORIGIN'] ?? 'https://shop.ozikoro.com').replace(/\/+$/, '');

const token = process.env['CLOUDFLARE_API_TOKEN'];
const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
const databaseName = process.env['STORE_DATABASE'] ?? 'ozikoro-store';

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  process.exit(2);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const allArgs = (name) =>
  process.argv.filter((value, index) => process.argv[index - 1] === `--${name}`);

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

async function databaseId() {
  const databases = await api(`/accounts/${accountId}/d1/database`);
  const found = (databases ?? []).find((entry) => entry.name === databaseName);
  if (!found) throw new Error(`No D1 database named "${databaseName}".`);
  return found.uuid;
}

async function sql(dbId, statement) {
  const result = await api(`/accounts/${accountId}/d1/database/${dbId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql: statement }),
  });
  return result?.[0]?.results ?? [];
}

const escape = (value) => String(value).replace(/'/g, "''");

async function register() {
  const name = arg('name');
  const redirects = allArgs('redirect');
  const postLogout = allArgs('post-logout');
  const scopes = arg('scopes', 'openid profile email');
  const isPublic = process.argv.includes('--public');
  const confidential = process.argv.includes('--confidential');

  if (!name) throw new Error('--name is required');
  if (!redirects.length) throw new Error('at least one --redirect is required');
  if (isPublic && confidential) throw new Error('choose --public or --confidential, not both');

  for (const uri of redirects) {
    if (!/^https:\/\//.test(uri) && !/^http:\/\/localhost/.test(uri)) {
      throw new Error(`a redirect URI must be https, or localhost for development: ${uri}`);
    }
    if (uri.endsWith('/')) {
      throw new Error(`a redirect URI must not end in a slash, because the match is exact: ${uri}`);
    }
  }

  const dbId = await databaseId();
  const clientId = `ozk_${randomBytes(9).toString('hex')}`;
  const secret = confidential ? randomBytes(32).toString('base64url') : null;
  const secretHash = secret ? createHash('sha256').update(secret).digest('hex') : null;

  await sql(
    dbId,
    `INSERT INTO oauth_clients (id, client_id, client_secret_hash, name, redirect_uris, scopes, is_public, post_logout_uris)
     VALUES (
       'cli_${randomBytes(9).toString('hex')}',
       '${escape(clientId)}',
       ${secretHash ? `'${secretHash}'` : 'NULL'},
       '${escape(name)}',
       '${escape(JSON.stringify(redirects))}',
       '${escape(scopes)}',
       ${secret ? 0 : 1},
       '${escape(JSON.stringify(postLogout))}'
     )`
  );

  console.log(`\nRegistered "${name}"\n`);
  console.log(`  client_id       ${clientId}`);
  console.log(`  type            ${secret ? 'confidential (secret required)' : 'public (PKCE is what protects it)'}`);
  if (secret) console.log(`  client_secret   ${secret}`);
  console.log(`  redirect URIs   ${redirects.join('\n                  ')}`);
  console.log(`  scopes          ${scopes}`);
  console.log(`\n  discovery       ${ISSUER}/.well-known/openid-configuration`);
  console.log(`  authorize       ${ISSUER}/oidc/authorize`);
  console.log(`  token           ${ISSUER}/oidc/token`);
  console.log(`  userinfo        ${ISSUER}/oidc/userinfo`);
  console.log(`  jwks            ${ISSUER}/oidc/jwks.json`);
  console.log(`  logout          ${ISSUER}/oidc/logout`);

  if (secret) {
    console.log('\n  The secret is shown ONCE and stored only as a SHA-256, so it cannot be');
    console.log('  recovered. Put it in the client\'s SERVER environment. Never in a browser');
    console.log('  bundle, and never behind a VITE_ prefix.');
  }
  console.log('');
}

async function list() {
  const dbId = await databaseId();
  const rows = await sql(
    dbId,
    `SELECT client_id, name, is_public, is_active, redirect_uris, scopes FROM oauth_clients ORDER BY name`
  );
  if (!rows.length) {
    console.log('No clients registered.');
    return;
  }
  for (const row of rows) {
    console.log(`\n${row.name}`);
    console.log(`  client_id   ${row.client_id}`);
    console.log(`  type        ${row.is_public ? 'public' : 'confidential'}${row.is_active ? '' : '  (INACTIVE)'}`);
    console.log(`  redirects   ${JSON.parse(row.redirect_uris).join('\n              ')}`);
    console.log(`  scopes      ${row.scopes}`);
  }
  console.log('');
}

async function deactivate() {
  const clientId = arg('client-id');
  if (!clientId) throw new Error('--client-id is required');
  const dbId = await databaseId();
  await sql(dbId, `UPDATE oauth_clients SET is_active = 0 WHERE client_id = '${escape(clientId)}'`);
  console.log(`Deactivated ${clientId}. Existing refresh tokens for it remain valid until they expire;`);
  console.log('delete them if the client is compromised.');
}

const command = process.argv[2];
const commands = { register, list, deactivate };

if (!commands[command]) {
  console.error('usage: oidc-client.mjs <register|list|deactivate> [options]');
  process.exit(2);
}

commands[command]().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
