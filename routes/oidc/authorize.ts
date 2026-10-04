/**
 * GET /oidc/authorize — the start of every sign-in on a client platform.
 *
 * This is a RAW Nitro route, not a React page, for two reasons: it must be able
 * to answer with a redirect before any application code runs, and the login and
 * consent screens are simple enough that they do not need the store's whole
 * client bundle. A third reason matters more: keeping the protocols in their own
 * files means a mistake here cannot be hidden by the React app catching it.
 *
 * THE CHECKS, IN ORDER, AND WHY EACH ONE IS HERE
 *
 *   1. `client_id` must exist and be active. An unknown client gets an error
 *      page, never a redirect.
 *
 *   2. `redirect_uri` must match a registered URI EXACTLY. This is the single
 *      most important check in the file: the authorisation code is a bearer
 *      credential for the account, and an open redirect here hands it to
 *      whoever asked. Only after this check passes may an error be reported BY
 *      REDIRECTING — before it, redirecting would itself be the vulnerability.
 *
 *   3. `response_type` must be `code`. No implicit flow: a token in a URL
 *      fragment is a token in browser history.
 *
 *   4. PKCE, S256 only. Required even of a client that holds a secret, because
 *      the code travels through the browser either way.
 *
 *   5. The scope must be one the client is registered for, and must include
 *      `openid`.
 *
 * Then: if there is no session, show the sign-in form; if there is one and
 * consent has not been given for these scopes, show the consent screen; if both
 * are settled, issue the code and redirect.
 */

import { tryDb } from '../../src/lib/env';
import { actorFromToken, SESSION_COOKIE } from '../../src/lib/auth';
import {
  checkPkce,
  findClient,
  grantedScopes,
  hasConsent,
  isRedirectAllowed,
  issueAuthCode,
  recordConsent,
} from '../../src/lib/oidc-clients';
import { renderAuthPage, readForm } from '../../src/lib/oidc-pages';

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached: this page carries a session-dependent decision.
      'cache-control': 'no-store',
    },
  });
}

/** An error that may safely be reported by redirecting back to the client. */
function redirectError(redirectUri: string, error: string, description: string, state: string, responseMode: string): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  if (responseMode === 'form_post') {
    // Not supported: `form_post` would need a self-submitting form, and the
    // discovery document does not advertise it.
    return html(renderAuthPage({ title: 'Unsupported', message: 'This provider does not support form_post.' }), 400);
  }
  return new Response(null, { status: 302, headers: { location: url.toString(), 'cache-control': 'no-store' } });
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export default {
  async fetch(request: Request): Promise<Response> {
    // One handler for both verbs: the consent form posts here, and Nitro's route
    // module exposes a single entry point.
    if (request.method === 'POST') return await handleConsent(request);
    return await handleAuthorize(request);
  },
};

async function handleAuthorize(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const params = url.searchParams;

    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const responseType = params.get('response_type') ?? '';
    const scope = params.get('scope') ?? 'openid';
    const state = params.get('state') ?? '';
    const nonce = params.get('nonce') ?? '';
    const codeChallenge = params.get('code_challenge');
    const codeChallengeMethod = params.get('code_challenge_method');

    if (!tryDb()) {
      return html(renderAuthPage({ title: 'Unavailable', message: 'The identity provider is not connected.' }), 503);
    }

    // 1. The client.
    const client = await findClient(clientId);
    if (!client || !client.is_active) {
      // No redirect: an unknown client is not a destination we trust.
      return html(
        renderAuthPage({
          title: 'Unknown application',
          message:
            'That application is not registered with Ozikoro. If you were sent here by a link, the link is wrong; if you are the operator, register the client first.',
        }),
        400
      );
    }

    // 2. The redirect URI, exactly.
    if (!isRedirectAllowed(client, redirectUri)) {
      return html(
        renderAuthPage({
          title: 'Redirect not allowed',
          message: `The address "${redirectUri}" is not registered for ${client.name}, so no sign-in can be sent to it.`,
        }),
        400
      );
    }

    // 3. The response type.
    if (responseType !== 'code') {
      return redirectError(redirectUri, 'unsupported_response_type', 'only response_type=code is supported', state, '');
    }

    // 4. PKCE.
    const pkce = checkPkce(codeChallenge, codeChallengeMethod);
    if (!pkce.ok) {
      return redirectError(redirectUri, 'invalid_request', pkce.reason, state, '');
    }

    // 5. Scopes.
    const scopes = grantedScopes(client, scope);
    if (!scopes.length) {
      return redirectError(
        redirectUri,
        'invalid_scope',
        `${client.name} is not registered for the scopes it asked for`,
        state,
        ''
      );
    }
    const grantedScope = scopes.join(' ');

    // Who is asking? The session cookie, resolved the same way the store does.
    const token = cookieValue(request, SESSION_COOKIE);
    const actor = token ? await actorFromToken(token) : null;

    // A signed-out visitor is sent to the store's sign-in, with this exact
    // request preserved so the journey resumes rather than restarts.
    if (!actor?.customerId) {
      const login = new URL(`${url.origin}/account`);
      login.searchParams.set('next', `${url.pathname}${url.search}`);
      return new Response(null, { status: 302, headers: { location: login.toString(), 'cache-control': 'no-store' } });
    }

    // Consent, unless already granted for these scopes.
    const consented = await hasConsent(actor.customerId, client.client_id, grantedScope);

    if (!consented) {
      return html(
        renderAuthPage({
          title: `Continue to ${client.name}`,
          message: `${client.name} is asking to use your Ozikoro account.`,
          form: {
            action: '/oidc/authorize',
            fields: {
              client_id: client.client_id,
              redirect_uri: redirectUri,
              scope: grantedScope,
              state,
              nonce,
              code_challenge: pkce.challenge,
              code_challenge_method: codeChallengeMethod ?? 'S256',
            },
            submit: `Continue as ${actor.email}`,
            deny: `Deny`,
            scopes,
          },
        })
      );
    }

    const code = await issueAuthCode({
      clientId: client.client_id,
      customerId: actor.customerId,
      redirectUri,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: codeChallengeMethod ?? 'S256',
      scope: grantedScope,
      nonce,
    });

    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    if (state) back.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { location: back.toString(), 'cache-control': 'no-store' } });
}

/**
 * The consent form posts here: `decision=allow` records consent and issues the
 * code, `decision=deny` reports it to the client as `access_denied`.
 */
async function handleConsent(request: Request): Promise<Response> {
    const form = await readForm(request);
    const clientId = form['client_id'] ?? '';
    const redirectUri = form['redirect_uri'] ?? '';
    const scope = form['scope'] ?? 'openid';
    const state = form['state'] ?? '';
    const nonce = form['nonce'] ?? '';
    const codeChallenge = form['code_challenge'] ?? '';
    const method = form['code_challenge_method'] ?? 'S256';
    const decision = form['decision'] ?? 'deny';

    const client = await findClient(clientId);
    if (!client || !isRedirectAllowed(client, redirectUri)) {
      return html(renderAuthPage({ title: 'Refused', message: 'The request could not be verified.' }), 400);
    }

    const token = cookieValue(request, SESSION_COOKIE);
    const actor = token ? await actorFromToken(token) : null;
    if (!actor?.customerId) {
      return html(renderAuthPage({ title: 'Signed out', message: 'Your session ended. Start again from the application.' }), 401);
    }

    if (decision !== 'allow') {
      return redirectError(redirectUri, 'access_denied', 'the account holder declined', state, '');
    }

    const scopes = grantedScopes(client, scope);
    if (!scopes.length) {
      return redirectError(redirectUri, 'invalid_scope', 'the requested scopes are not registered', state, '');
    }
    const grantedScope = scopes.join(' ');

    const pkce = checkPkce(codeChallenge, method);
    if (!pkce.ok) return redirectError(redirectUri, 'invalid_request', pkce.reason, state, '');

    await recordConsent(actor.customerId, client.client_id, grantedScope);

    const code = await issueAuthCode({
      clientId: client.client_id,
      customerId: actor.customerId,
      redirectUri,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: method,
      scope: grantedScope,
      nonce,
    });

    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    if (state) back.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { location: back.toString(), 'cache-control': 'no-store' } });
}
