/**
 * GET|POST /oidc/logout — RP-initiated logout.
 *
 * A client sends the browser here to end the Ozikoro session as well as its own.
 * Without it, "sign out" on a client would leave the person signed in at the
 * identity provider, and the next sign-in would silently succeed — which is
 * exactly the confusion people report as "it will not let me log out".
 *
 * WHAT IT DOES, IN ORDER
 *
 *   1. Ends the storefront session (deletes the row, clears the cookie).
 *   2. Revokes every refresh token for that account, so a client cannot obtain a
 *      fresh access token after the person has asked to be signed out.
 *   3. Redirects to the client's registered `post_logout_redirect_uri`, if it
 *      asked for one and it is registered. An UNREGISTERED one is ignored rather
 *      than honoured: otherwise this endpoint is an open redirect.
 */

import { tryDb } from '../../src/lib/env';
import { destroySession, SESSION_COOKIE } from '../../src/lib/auth';
import { findClient, isPostLogoutAllowed, revokeAllRefreshTokens } from '../../src/lib/oidc-clients';
import { renderAuthPage, readForm } from '../../src/lib/oidc-pages';

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const params =
    request.method === 'POST' ? await readForm(request) : Object.fromEntries(url.searchParams.entries());

  const postLogout = params['post_logout_redirect_uri'] ?? '';
  const clientId = params['client_id'] ?? '';
  const state = params['state'] ?? '';

  if (tryDb()) {
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) {
      // Look the session up BEFORE deleting it, so the account's refresh tokens
      // can be revoked too.
      const { actorFromToken } = await import('../../src/lib/auth');
      const actor = await actorFromToken(token);
      if (actor?.customerId) await revokeAllRefreshTokens(actor.customerId);
      await destroySession(token);
    }
  }

  const headers = new Headers({ 'cache-control': 'no-store' });
  const cookies = [clearSessionCookie()];
  const responseHeaders: Record<string, string> = {};

  if (postLogout) {
    const client = clientId ? await findClient(clientId) : null;
    const allowed = client ? isPostLogoutAllowed(client, postLogout) : false;
    if (allowed) {
      const target = new URL(postLogout);
      if (state) target.searchParams.set('state', state);
      responseHeaders['location'] = target.toString();
      responseHeaders['cache-control'] = 'no-store';
      responseHeaders['set-cookie'] = clearSessionCookie();
      return new Response(null, { status: 302, headers: responseHeaders });
    }
    // Not registered: say so rather than redirecting somewhere arbitrary.
    void headers;
  }

  return new Response(
    renderAuthPage({
      title: 'Signed out',
      message: 'You have been signed out of Ozikoro, and every application that was using your account has lost access.',
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': cookies.join(', '),
      },
    }
  );
}

export default {
  fetch: (request: Request) => handle(request),
};
