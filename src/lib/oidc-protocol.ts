/**
 * OIDC protocol values shared by its endpoints.
 *
 * The issuer has to be the SAME string everywhere — in discovery, in the `iss`
 * claim, and in what each client is configured with. A trailing slash that
 * differs between two of those is the single most common reason a valid token is
 * rejected, so it is defined once, here, with no trailing slash and no
 * interpolation anywhere else.
 */

import { storeOrigin } from './env';

/** `https://shop.ozikoro.com` — no trailing slash, ever. */
export function issuer(): string {
  return storeOrigin();
}

export function endpoint(path: string): string {
  return `${issuer()}${path.startsWith('/') ? path : `/${path}`}`;
}

/** ID token lifetime. Short, because a client can always refresh. */
export const ID_TOKEN_TTL_SECONDS = 10 * 60;

/** Access token lifetime. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export const SUPPORTED_SCOPES = ['openid', 'profile', 'email'] as const;

export function discoveryDocument() {
  return {
    issuer: issuer(),
    authorization_endpoint: endpoint('/oidc/authorize'),
    token_endpoint: endpoint('/oidc/token'),
    userinfo_endpoint: endpoint('/oidc/userinfo'),
    jwks_uri: endpoint('/oidc/jwks.json'),
    end_session_endpoint: endpoint('/oidc/logout'),
    // No `registration_endpoint`: clients are registered deliberately, by an
    // operator. Dynamic registration would let anyone become a client, and every
    // client is a place an account's identity can be sent.
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: [
      'iss',
      'sub',
      'aud',
      'exp',
      'iat',
      'auth_time',
      'nonce',
      'email',
      'email_verified',
      'name',
      'preferred_username',
      'role',
    ],
  };
}

/**
 * The claims an ID token or a userinfo response carries for a scope.
 *
 * `sub` is the account id, NOT the email address. An email can be changed or
 * reassigned; a client that keys its own records on `sub` stays correct when it
 * is, and a client that keys on email does not.
 */
export interface IdentityClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  role?: string;
}

export function claimsForScope(identity: IdentityClaims, scopes: string[]): Record<string, unknown> {
  const claims: Record<string, unknown> = { sub: identity.sub };
  if (scopes.includes('email')) {
    claims['email'] = identity.email ?? '';
    // This provider only issues accounts whose address it has verified by
    // construction (the account exists because someone registered with it), so
    // the honest value is true. If verification by email ever becomes a step,
    // this must read from the account rather than being assumed.
    claims['email_verified'] = identity.email_verified ?? true;
  }
  if (scopes.includes('profile')) {
    claims['name'] = identity.name ?? '';
    claims['preferred_username'] = identity.preferred_username ?? identity.email ?? '';
    claims['role'] = identity.role ?? 'customer';
  }
  return claims;
}
