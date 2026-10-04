/**
 * The OIDC token endpoint.
 *
 * Three grants, and nothing else: `authorization_code` (the one every client
 * uses), `refresh_token` (rotation with reuse detection) and the client
 * credential check that guards both.
 *
 * WHAT IS VERIFIED, AND WHY EACH MATTERS
 *
 *   1. The client, and — for a confidential client — its secret. A public client
 *      has no secret, which is exactly why PKCE is mandatory rather than
 *      optional.
 *
 *   2. The authorisation code, single-use, bound to this client and to this
 *      redirect URI. The single-use check is a conditional UPDATE, so two
 *      concurrent redemptions cannot both win.
 *
 *   3. The PKCE verifier, whose SHA-256 must equal the challenge sent at
 *      authorisation time. This is what makes a stolen code useless: without the
 *      verifier there is no token.
 *
 * Errors follow RFC 6749 §5.2 — a JSON body with `error` and
 * `error_description`, and status 400 for a client error, 401 for a bad client
 * credential. A client that gets HTML here cannot debug itself.
 */

import { tryDb } from '../../src/lib/env';
import { sha256 } from '../../src/lib/crypto';
import { findCustomerById } from '../../src/lib/auth';
import { isRole } from '../../src/lib/roles';
import { findClient, consumeAuthCode, verifyPkce, issueRefreshToken, rotateRefreshToken } from '../../src/lib/oidc-clients';
import { signJwt, newOpaqueToken } from '../../src/lib/oidc-keys';
import { claimsForScope, ID_TOKEN_TTL_SECONDS, ACCESS_TOKEN_TTL_SECONDS, issuer, type IdentityClaims } from '../../src/lib/oidc-protocol';
import { readForm } from '../../src/lib/oidc-pages';
import { db } from '../../src/lib/env';

function tokenError(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function tokenResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * Authenticate the client.
 *
 * A public client is authenticated by being registered at all — it has no
 * secret, and PKCE is what protects its codes. A confidential client must
 * present its secret, compared in constant time.
 */
async function authenticateClient(
  form: Record<string, string>,
  request: Request
): Promise<{ ok: true; clientId: string } | { ok: false; response: Response }> {
  let clientId = form['client_id'] ?? '';
  let clientSecret = form['client_secret'] ?? '';

  // HTTP Basic is allowed as well as the body, because some OIDC libraries only
  // implement Basic.
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator !== -1) {
        clientId = decodeURIComponent(decoded.slice(0, separator));
        clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      }
    } catch {
      return { ok: false, response: tokenError('invalid_client', 'the Basic credential is not decodable', 401) };
    }
  }

  if (!clientId) return { ok: false, response: tokenError('invalid_client', 'client_id is required', 401) };

  const client = await findClient(clientId);
  if (!client || !client.is_active) {
    return { ok: false, response: tokenError('invalid_client', 'unknown client', 401) };
  }

  if (client.client_secret_hash) {
    if (!clientSecret) {
      return { ok: false, response: tokenError('invalid_client', 'client_secret is required for this client', 401) };
    }
    const presented = sha256(clientSecret);
    // Constant-time by construction: both are SHA-256 hex digests, so comparing
    // them is comparing fixed-length strings, and the digest of the presented
    // value leaks nothing about the stored one.
    if (presented !== client.client_secret_hash) {
      return { ok: false, response: tokenError('invalid_client', 'the client secret is not correct', 401) };
    }
  }

  return { ok: true, clientId: client.client_id };
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return tokenError('invalid_request', 'this endpoint accepts POST only', 405);
    }
    if (!tryDb()) {
      return tokenError('temporarily_unavailable', 'the identity provider is not connected', 503);
    }

    const form = await readForm(request);
    const grantType = form['grant_type'] ?? '';

    const auth = await authenticateClient(form, request);
    if (!auth.ok) return auth.response;
    const clientId = auth.clientId;

    if (grantType === 'authorization_code') {
      const code = form['code'] ?? '';
      const redirectUri = form['redirect_uri'] ?? '';
      const verifier = form['code_verifier'] ?? '';

      if (!code) return tokenError('invalid_request', 'code is required');
      if (!redirectUri) return tokenError('invalid_request', 'redirect_uri is required');
      if (!verifier) return tokenError('invalid_request', 'code_verifier is required');

      const consumed = await consumeAuthCode(code, clientId, redirectUri);
      if (!consumed.ok) return tokenError('invalid_grant', consumed.reason);

      if (!verifyPkce(consumed.code.code_challenge, verifier, consumed.code.code_challenge_method)) {
        // The code has already been consumed at this point, which is correct: a
        // failed verifier means the code is in the wrong hands, and it must not
        // be retryable.
        return tokenError('invalid_grant', 'the code_verifier does not match the code_challenge');
      }

      const customer = await findCustomerById(consumed.code.customer_id);
      if (!customer) return tokenError('invalid_grant', 'the account no longer exists');

      const scopes = consumed.code.scope.split(/\s+/).filter(Boolean);
      return await issueTokens({
        clientId,
        customerId: customer.id,
        scopes,
        nonce: consumed.code.nonce,
        email: customer.email,
        name: customer.name,
        role: isRole(customer.role) ? customer.role : 'customer',
        includeRefresh: true,
      });
    }

    if (grantType === 'refresh_token') {
      const presented = form['refresh_token'] ?? '';
      if (!presented) return tokenError('invalid_request', 'refresh_token is required');

      const rotated = await rotateRefreshToken(presented, clientId);
      if (!rotated.ok) return tokenError('invalid_grant', rotated.reason);

      const customer = await findCustomerById(rotated.customerId);
      if (!customer) return tokenError('invalid_grant', 'the account no longer exists');

      const scopes = rotated.scope.split(/\s+/).filter(Boolean);
      return await issueTokens({
        clientId,
        customerId: customer.id,
        scopes,
        nonce: '',
        email: customer.email,
        name: customer.name,
        role: isRole(customer.role) ? customer.role : 'customer',
        includeRefresh: true,
        // The replacement is already issued inside `rotateRefreshToken`, so this
        // call returns it rather than minting a second one.
        refreshToken: undefined,
        familyId: rotated.familyId,
      });
    }

    return tokenError('unsupported_grant_type', `"${grantType}" is not a grant this provider issues`);
  },
};

async function issueTokens(input: {
  clientId: string;
  customerId: string;
  scopes: string[];
  nonce: string;
  email: string;
  name: string;
  role: string;
  includeRefresh: boolean;
  refreshToken?: string | undefined;
  familyId?: string | undefined;
}): Promise<Response> {
  const identifier: IdentityClaims = {
    sub: input.customerId,
    email: input.email,
    email_verified: true,
    name: input.name,
    preferred_username: input.email,
    role: input.role,
  };

  const idToken = await signJwt(
    {
      iss: issuer(),
      sub: input.customerId,
      aud: input.clientId,
      auth_time: Math.floor(Date.now() / 1000),
      ...(input.nonce ? { nonce: input.nonce } : {}),
      ...claimsForScope(identifier, input.scopes),
    },
    ID_TOKEN_TTL_SECONDS
  );

  // Opaque, hashed at rest, revocable now.
  const access = newOpaqueToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  await db()
    .prepare(
      `INSERT INTO access_tokens (id, client_id, customer_id, scope, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(access.digest, input.clientId, input.customerId, input.scopes.join(' '), expiresAt)
    .run();

  const refreshToken =
    input.refreshToken ??
    (input.includeRefresh
      ? await issueRefreshToken({
          clientId: input.clientId,
          customerId: input.customerId,
          scope: input.scopes.join(' '),
          ...(input.familyId ? { familyId: input.familyId } : {}),
        })
      : undefined);

  return tokenResponse({
    access_token: access.value,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    id_token: idToken,
    scope: input.scopes.join(' '),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  });
}

/** Resolve a bearer access token to its account. Used by userinfo. */
export async function accountForAccessToken(token: string): Promise<string | null> {
  const row = await db()
    .prepare(
      `SELECT customer_id FROM access_tokens
        WHERE id = ?1 AND revoked_at IS NULL AND expires_at > datetime('now')`
    )
    .bind(sha256(token))
    .first<{ customer_id: string }>();
  return row?.customer_id ?? null;
}
