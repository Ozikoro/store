/**
 * The client half of OIDC, for the store's own sign-in.
 *
 * `startOidcSignIn` builds the authorisation URL and the PKCE material;
 * `completeOidcSignIn` exchanges the code for tokens and establishes a session.
 *
 * WHY THE STORE IS A CLIENT OF ITS OWN PROVIDER
 *
 * It looks circular. It is not, and the alternative is worse: if the store
 * signed in through a private path and the other platforms used OIDC, there
 * would be two sign-in mechanisms to keep correct, and the one exercised least
 * would rot. Exercising the public protocol on every real sign-in means a
 * regression in it breaks the store immediately, in development, rather than
 * quietly breaking only the integrations.
 */

import { createServerFn } from '@tanstack/react-start';
import { randomBytes, createHash } from 'node:crypto';
import { db, env, tryDb, storeOrigin } from '../lib/env';
import { createSession, findCustomerById, SESSION_COOKIE } from '../lib/auth';
import { isRole } from '../lib/roles';
import { issuer, type IdentityClaims } from '../lib/oidc-protocol';
import { findClient } from '../lib/oidc-clients';

/**
 * The store's own client id.
 *
 * A public client, because its redirect happens in a browser and a browser
 * cannot keep a secret. PKCE is what protects the exchange, which is exactly the
 * case PKCE exists for. Read from the environment so the same build can be
 * pointed at a different registration.
 */
function storeClientId(): string {
  return env().STORE_OIDC_CLIENT_ID ?? 'ozk_4daaae6a6b6d7cbb48';
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface SignInStart {
  authorizationUrl: string;
  verifier: string;
  state: string;
}

/**
 * Build the authorisation URL for a sign-in.
 *
 * The verifier is returned to the BROWSER, which keeps it in `sessionStorage`
 * and never in a cookie or a URL. It is the one half of the exchange an attacker
 * who intercepted the code does not have.
 */
export const startOidcSignIn = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const data = (input ?? {}) as Record<string, unknown>;
    return { returnTo: typeof data['returnTo'] === 'string' && data['returnTo'].startsWith('/') ? data['returnTo'] : '/account' };
  })
  .handler(async ({ data }): Promise<SignInStart> => {
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier, 'utf8').digest());
    const state = base64url(randomBytes(16));
    const redirectUri = `${storeOrigin()}/oidc/callback`;

    const url = new URL(`${issuer()}/oidc/authorize`);
    url.searchParams.set('client_id', storeClientId());
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', base64url(randomBytes(16)));
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return { authorizationUrl: url.toString(), verifier, state: `${state}|${data.returnTo}` };
  });

export type CompleteSignIn =
  | { ok: true; email: string }
  | { ok: false; error: string };

/**
 * Exchange the code for tokens, then establish the store's own session.
 *
 * The three checks that matter, in order:
 *
 *   1. The token endpoint must accept the exchange. It verifies the PKCE
 *      verifier, so a stolen code is useless here.
 *   2. The ID token must verify against the provider's JWKS, and its `iss` and
 *      `aud` must be right. Without this the store would be trusting a token it
 *      had not checked — which is the whole failure this design exists to avoid.
 *   3. The account named by `sub` must exist locally. The provider OWNS identity;
 *      the store keeps a local row so orders have an owner, and it is created on
 *      first sight rather than being a second source of truth.
 */
export const completeOidcSignIn = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const data = input as { code?: unknown; codeVerifier?: unknown };
    if (typeof data?.code !== 'string' || !data.code) throw new Error('Missing sign-in code.');
    if (typeof data?.codeVerifier !== 'string' || !data.codeVerifier) {
      throw new Error('Missing the sign-in verifier for this browser.');
    }
    return { code: data.code, codeVerifier: data.codeVerifier };
  })
  .handler(async ({ data }): Promise<CompleteSignIn> => {
    if (!tryDb()) return { ok: false, error: 'The account service is not connected.' };

    const redirectUri = `${storeOrigin()}/oidc/callback`;

    const tokenResponse = await fetch(`${issuer()}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: data.code,
        redirect_uri: redirectUri,
        client_id: storeClientId(),
        code_verifier: data.codeVerifier,
      }),
    });

    const tokens = (await tokenResponse.json().catch(() => null)) as
      | { id_token?: string; access_token?: string; error_description?: string }
      | null;

    if (!tokenResponse.ok || !tokens?.id_token) {
      return { ok: false, error: tokens?.error_description ?? 'The sign-in could not be completed.' };
    }

    // Verify the ID token with the provider's public keys. Imported dynamically
    // because this module is reachable from the client graph and the key module
    // uses `node:crypto` at module scope.
    const { verifyJwt } = await import('../lib/oidc-keys');
    const verified = await verifyJwt(tokens.id_token);
    if (!verified.ok) {
      return { ok: false, error: `The sign-in token could not be verified (${verified.reason}).` };
    }

    const payload = verified.payload as unknown as IdentityClaims & { aud?: unknown; iss?: unknown };
    if (payload.iss !== issuer()) return { ok: false, error: 'The sign-in token came from another issuer.' };
    if (payload.aud !== storeClientId()) return { ok: false, error: 'The sign-in token was issued to another application.' };

    const subject = typeof payload.sub === 'string' ? payload.sub : '';
    if (!subject) return { ok: false, error: 'The sign-in token named no account.' };

    // The provider owns identity; the store keeps a local row so an order has an
    // owner. Created on first sight, and kept in step on every later sign-in.
    let customerId = subject;
    const existing = await findCustomerById(customerId);

    if (!existing) {
      const email = typeof payload.email === 'string' ? payload.email : '';
      if (!email) return { ok: false, error: 'The account has no email address, so it cannot own an order.' };

      // An account may already exist here with the same address from a guest
      // checkout. Adopting that row keeps the person's order history whole
      // rather than splitting it across two rows.
      const { findCustomerByEmail } = await import('../lib/auth');
      const byEmail = await findCustomerByEmail(email);
      if (byEmail) {
        customerId = byEmail.id;
      } else {
        await db()
          .prepare(
            `INSERT INTO customers (id, email, name, role) VALUES (?1, ?2, ?3, 'customer')
             ON CONFLICT(id) DO NOTHING`
          )
          .bind(customerId, email, typeof payload.name === 'string' ? payload.name : '')
          .run();
      }
    }

    const customer = await findCustomerById(customerId);
    if (!customer) return { ok: false, error: 'The account could not be recorded locally.' };

    const { token, expiresAt } = await createSession({
      customerId: customer.id,
      role: isRole(customer.role) ? customer.role : 'customer',
    });

    const { setCookie } = await import('@tanstack/react-start/server');
    setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      expires: expiresAt,
    });

    return { ok: true, email: customer.email };
  });

/** What a person has authorised, for the connected-applications screen. */
export const connectedApplications = createServerFn({ method: 'GET' }).handler(async () => {
  const { actorFromToken: resolve } = await import('../lib/auth');
  const { readCookie } = await import('./request');
  const actor = await resolve(readCookie(SESSION_COOKIE) ?? null);
  if (!actor?.customerId) return [];
  const { consentsFor } = await import('../lib/oidc-clients');
  return consentsFor(actor.customerId);
});
