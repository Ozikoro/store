/**
 * The client registry and the OIDC protocol rules.
 *
 * Kept apart from the HTTP endpoints so the decisions — is this redirect URI
 * allowed, is this PKCE challenge acceptable, may this client use this scope —
 * are plain functions that can be tested without a request.
 */

import { db } from './env';
import { createHash, timingSafeEqual } from 'node:crypto';
import { randomToken, sha256 } from './crypto';

export interface OAuthClient {
  id: string;
  client_id: string;
  client_secret_hash: string | null;
  name: string;
  redirect_uris: string;
  scopes: string;
  is_public: number;
  post_logout_uris: string;
  is_active: number;
  created_at: string;
}

export function parseList(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export async function findClient(clientId: string): Promise<OAuthClient | null> {
  // The bound statement is assigned to a name rather than chained.
  //
  // NOT a style choice. Written as one expression
  // (`prepare(...).bind(id).first()`), the bundler's minifier dropped the
  // `.bind(...)` call from the production bundle: by the types it is a no-op
  // that returns `this`, so the minifier removed it as dead code — and the
  // deployed Worker then sent a query with a placeholder and no value, which D1
  // rejects at runtime. The bug existed only in the built output; the source and
  // the type-check were both clean. Naming the intermediate result makes the
  // call impossible to elide.
  const statement = db().prepare('SELECT * FROM oauth_clients WHERE client_id = ?1').bind(clientId);
  return statement.first<OAuthClient>();
}

export async function listClients(): Promise<OAuthClient[]> {
  const result = await db().prepare('SELECT * FROM oauth_clients ORDER BY name').all<OAuthClient>();
  return result.results ?? [];
}

/**
 * Is this exact redirect URI registered for this client?
 *
 * EXACT match, and the whole point of the check. A `startsWith` or a wildcard
 * would let an attacker register `https://client.example/callback/../evil` or
 * simply append to a permitted prefix, and the authorisation code — which is a
 * bearer credential for the account — would be delivered to them.
 */
export function isRedirectAllowed(client: OAuthClient, redirectUri: string): boolean {
  if (!client.is_active) return false;
  return parseList(client.redirect_uris).includes(redirectUri);
}

export function isPostLogoutAllowed(client: OAuthClient, uri: string): boolean {
  return parseList(client.post_logout_uris).includes(uri);
}

/**
 * The scopes this client may ask for: the intersection of what it requested and
 * what it is registered for. A client cannot widen its own access by asking.
 */
export function grantedScopes(client: OAuthClient, requested: string): string[] {
  const allowed = new Set(client.scopes.split(/\s+/).filter(Boolean));
  const asked = requested.split(/\s+/).filter(Boolean);
  const granted = asked.filter((scope) => allowed.has(scope));
  // `openid` is what makes this an OIDC request at all. Without it there is no
  // ID token; refuse rather than silently downgrading to a plain OAuth grant.
  return granted.includes('openid') ? granted : [];
}

/**
 * Validate a PKCE challenge.
 *
 * S256 only. `plain` is accepted by the specification and is worthless: it puts
 * the verifier in the authorisation request, where an attacker who can read the
 * request already has everything they need. Refusing it is the only defensible
 * choice.
 */
export function checkPkce(
  codeChallenge: string | null,
  method: string | null
): { ok: true; challenge: string } | { ok: false; reason: string } {
  if (!codeChallenge) return { ok: false, reason: 'code_challenge is required' };
  const resolved = method ?? 'plain';
  if (resolved !== 'S256') return { ok: false, reason: 'only the S256 code challenge method is accepted' };
  // A base64url SHA-256 is 43 characters. Anything else is not one.
  if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return { ok: false, reason: 'code_challenge is not a base64url SHA-256 digest' };
  }
  return { ok: true, challenge: codeChallenge };
}

/**
 * The verifier a client presents must hash to the challenge it sent.
 *
 * The comparison is in base64url, which is the encoding the specification
 * requires for `code_challenge` — `BASE64URL(SHA256(ASCII(verifier)))`. It is
 * NOT `sha256()` from `lib/crypto`, which returns lowercase hex for the
 * different job of hashing session tokens. Comparing a hex digest against a
 * base64url challenge can never succeed, and a verifier check that always fails
 * would have looked like a client bug.
 *
 * `timingSafeEqual` rather than `===`, on the principle that a security
 * comparison should not be the one place the codebase forgets it: both sides are
 * fixed-length digests, so there is no length to leak.
 */
export function verifyPkce(codeChallenge: string, verifier: string, method: string): boolean {
  if (method !== 'S256') return false;
  const digest = createHash('sha256').update(verifier, 'utf8').digest();
  const computed = digest.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(codeChallenge, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthCodeRow {
  id: string;
  client_id: string;
  customer_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  nonce: string;
  expires_at: string;
  consumed_at: string | null;
}

const AUTH_CODE_TTL_SECONDS = 60;

export async function issueAuthCode(input: {
  clientId: string;
  customerId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  nonce: string;
}): Promise<string> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SECONDS * 1000).toISOString();
  await db()
    .prepare(
      `INSERT INTO auth_codes (id, client_id, customer_id, redirect_uri, code_challenge, code_challenge_method, scope, nonce, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      sha256(token),
      input.clientId,
      input.customerId,
      input.redirectUri,
      input.codeChallenge,
      input.codeChallengeMethod,
      input.scope,
      input.nonce,
      expiresAt
    )
    .run();
  return token;
}

/**
 * Redeem an authorisation code, exactly once.
 *
 * The `consumed_at IS NULL` predicate is in the UPDATE, not in a read followed
 * by a write, so two concurrent redemptions cannot both succeed — the second
 * matches no row. That single-use property is what makes an intercepted code
 * worthless to an attacker who is one step behind the real client.
 */
export async function consumeAuthCode(
  token: string,
  clientId: string,
  redirectUri: string
): Promise<{ ok: true; code: AuthCodeRow } | { ok: false; reason: string }> {
  const digest = sha256(token);
  const row = await db()
    .prepare('SELECT * FROM auth_codes WHERE id = ?1')
    .bind(digest)
    .first<AuthCodeRow>();

  if (!row) return { ok: false, reason: 'unknown authorization code' };
  if (row.client_id !== clientId) return { ok: false, reason: 'the code was issued to another client' };
  // The redirect URI is re-checked here as well as at issue time. If it differs,
  // the code is being replayed somewhere it was not issued for.
  if (row.redirect_uri !== redirectUri) return { ok: false, reason: 'redirect_uri does not match the request' };
  if (row.consumed_at) {
    // A second use of a single-use code means the code leaked. There is no way
    // to tell the real client from the attacker, so the safe answer is to
    // refuse — and the client must re-authorise.
    return { ok: false, reason: 'this authorization code has already been used' };
  }
  const expiresAt = Date.parse(row.expires_at);
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, reason: 'the authorization code has expired' };
  }

  const claimed = await db()
    .prepare(`UPDATE auth_codes SET consumed_at = datetime('now') WHERE id = ?1 AND consumed_at IS NULL`)
    .bind(digest)
    .run();
  if (!claimed.meta || (claimed.meta['changes'] as number) === 0) {
    return { ok: false, reason: 'this authorization code has already been used' };
  }

  return { ok: true, code: row };
}

export async function purgeExpiredCodes(): Promise<void> {
  await db()
    .prepare(`DELETE FROM auth_codes WHERE expires_at <= datetime('now', '-1 hour')`)
    .run();
}

// ------------------------------------------------------------ refresh tokens

const REFRESH_TTL_DAYS = 30;

export interface RefreshRow {
  id: string;
  client_id: string;
  customer_id: string;
  scope: string;
  expires_at: string;
  family_id: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

export async function issueRefreshToken(input: {
  clientId: string;
  customerId: string;
  scope: string;
  familyId?: string;
}): Promise<string> {
  const token = randomToken(32);
  const familyId = input.familyId ?? randomToken(16);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db()
    .prepare(
      `INSERT INTO refresh_tokens (id, client_id, customer_id, scope, expires_at, family_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(sha256(token), input.clientId, input.customerId, input.scope, expiresAt, familyId)
    .run();
  return token;
}

export type RefreshResult =
  | { ok: true; customerId: string; scope: string; familyId: string }
  | { ok: false; reason: string };

/**
 * Rotate a refresh token.
 *
 * Rotation with reuse detection: a token that has already been used and is
 * presented again means it leaked, so the ENTIRE family is revoked — the
 * legitimate session and the attacker's alike. That is the intended trade: a
 * forced re-login is cheap, and silently serving both parties is not.
 */
export async function rotateRefreshToken(token: string, clientId: string): Promise<RefreshResult> {
  const digest = sha256(token);
  const row = await db().prepare('SELECT * FROM refresh_tokens WHERE id = ?1').bind(digest).first<RefreshRow>();

  if (!row) return { ok: false, reason: 'unknown refresh token' };
  if (row.client_id !== clientId) return { ok: false, reason: 'the token was issued to another client' };

  if (row.consumed_at || row.revoked_at) {
    await db()
      .prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE family_id = ?1 AND revoked_at IS NULL`)
      .bind(row.family_id)
      .run();
    return { ok: false, reason: 'this refresh token was already used; the whole session has been revoked' };
  }

  const expiresAt = Date.parse(row.expires_at);
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    return { ok: false, reason: 'the refresh token has expired' };
  }

  const replacement = await issueRefreshToken({
    clientId: row.client_id,
    customerId: row.customer_id,
    scope: row.scope,
    familyId: row.family_id,
  });

  await db()
    .prepare(
      `UPDATE refresh_tokens SET consumed_at = datetime('now'), replaced_by = ?2
        WHERE id = ?1 AND consumed_at IS NULL`
    )
    .bind(digest, sha256(replacement))
    .run();

  return { ok: true, customerId: row.customer_id, scope: row.scope, familyId: row.family_id };
}

/** Revoke everything for an account, on every client. Used by sign-out-everywhere. */
export async function revokeAllRefreshTokens(customerId: string): Promise<void> {
  await db()
    .prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE customer_id = ?1 AND revoked_at IS NULL`)
    .bind(customerId)
    .run();
}

// ------------------------------------------------------------------- consents

export async function recordConsent(customerId: string, clientId: string, scope: string): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO oauth_consents (id, customer_id, client_id, scope) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(customer_id, client_id) DO UPDATE SET scope = ?4, granted_at = datetime('now'), revoked_at = NULL`
    )
    .bind(`con_${randomToken(12)}`, customerId, clientId, scope)
    .run();
}

export async function hasConsent(customerId: string, clientId: string, scope: string): Promise<boolean> {
  const row = await db()
    .prepare(
      `SELECT scope FROM oauth_consents
        WHERE customer_id = ?1 AND client_id = ?2 AND revoked_at IS NULL`
    )
    .bind(customerId, clientId)
    .first<{ scope: string }>();
  if (!row) return false;
  const granted = new Set(row.scope.split(/\s+/).filter(Boolean));
  return scope.split(/\s+/).filter(Boolean).every((entry) => granted.has(entry));
}

/** What a person has granted, for the "connected apps" screen. */
export async function consentsFor(customerId: string): Promise<Array<{ client: string; scope: string; grantedAt: string }>> {
  const result = await db()
    .prepare(
      `SELECT c.name AS client, o.scope, o.granted_at AS grantedAt
         FROM oauth_consents o
         JOIN oauth_clients c ON c.client_id = o.client_id
        WHERE o.customer_id = ?1 AND o.revoked_at IS NULL
        ORDER BY o.granted_at DESC`
    )
    .bind(customerId)
    .all<{ client: string; scope: string; grantedAt: string }>();
  return result.results ?? [];
}

export async function revokeConsent(customerId: string, clientName: string): Promise<void> {
  await db()
    .prepare(
      `UPDATE oauth_consents SET revoked_at = datetime('now')
        WHERE customer_id = ?1
          AND client_id = (SELECT client_id FROM oauth_clients WHERE name = ?2)`
    )
    .bind(customerId, clientName)
    .run();
}
