/**
 * GET /oidc/userinfo — who the bearer token belongs to.
 *
 * The access token is presented in the `Authorization: Bearer` header. It is
 * resolved against the `access_tokens` table, so revoking an account or a grant
 * takes effect on the very next call — which is the whole reason the access
 * token is opaque rather than a self-contained JWT.
 *
 * A client that only needs to identify the account can use the ID token it
 * already received. This endpoint exists for the moment a client needs the
 * CURRENT name, email or role rather than the ones from sign-in time.
 */

import { tryDb, db } from '../../src/lib/env';
import { sha256 } from '../../src/lib/crypto';
import { findCustomerById } from '../../src/lib/auth';
import { isRole } from '../../src/lib/roles';
import { claimsForScope, type IdentityClaims } from '../../src/lib/oidc-protocol';
import { accountForAccessToken } from './token';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // A userinfo response is per-token; nothing may cache it.
      vary: 'Authorization',
    },
  });
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (!tryDb()) return json({ error: 'temporarily_unavailable' }, 503);

    const token = bearer(request);
    if (!token) {
      // The spec requires the challenge header, so a client can discover how to
      // authenticate rather than guess.
      return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'a bearer token is required' }), {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': 'Bearer realm="ozikoro", error="invalid_token"',
          'cache-control': 'no-store',
        },
      });
    }

    const customerId = await accountForAccessToken(token);
    if (!customerId) {
      return new Response(
        JSON.stringify({ error: 'invalid_token', error_description: 'the token is expired or has been revoked' }),
        {
          status: 401,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'www-authenticate': 'Bearer realm="ozikoro", error="invalid_token"',
            'cache-control': 'no-store',
          },
        }
      );
    }

    const customer = await findCustomerById(customerId);
    if (!customer) return json({ error: 'invalid_token' }, 401);

    // Which claims to include comes from the scopes this token was issued for.
    const scopeRow = await db()
      .prepare('SELECT scope FROM access_tokens WHERE id = ?1')
      .bind(
        // The same digest the resolver computed; recomputed here rather than
        // returned, so the resolver's contract stays a single id.
        sha256(token)
      )
      .first<{ scope: string }>();
    const scopes = (scopeRow?.scope ?? 'openid').split(/\s+/).filter(Boolean);

    const identity: IdentityClaims = {
      sub: customer.id,
      email: customer.email,
      email_verified: true,
      name: customer.name,
      preferred_username: customer.email,
      role: isRole(customer.role) ? customer.role : 'customer',
    };

    return json(claimsForScope(identity, scopes));
  },
};
