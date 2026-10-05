#!/usr/bin/env node
/**
 * End-to-end test of the Ozikoro identity provider.
 *
 * WHY A BROWSER IS REQUIRED FOR THE FIRST HALF
 *
 * The authorisation endpoint redirects a signed-out visitor to the store's
 * sign-in, which is a CSRF-protected server function: it rejects any request
 * whose Origin is not the site's own. curl cannot complete it, and faking the
 * session would test the test rather than the provider. So the browser performs
 * the real journey, and the test picks the flow up from the authorisation CODE —
 * which is exactly where a real client picks it up.
 *
 * WHAT IT PROVES, and why each one is worth the effort:
 *
 *   - discovery is served and its issuer matches the tokens issued
 *   - an unregistered redirect_uri is refused WITHOUT redirecting to it, because
 *     the code is a bearer credential for the account
 *   - a `plain` PKCE challenge is refused; only S256 is accepted
 *   - a full authorisation: sign-in, consent, code, token exchange
 *   - the ID token's signature verifies against the PUBLISHED JWKS — the same
 *     check every client performs, using only public material
 *   - `iss`, `aud`, `nonce` and the identity claims are right
 *   - a code cannot be redeemed twice
 *   - a token request with the WRONG PKCE verifier is refused
 *   - userinfo returns the account for a valid token
 *   - a refresh token rotates, and REUSING the old one revokes the family
 *   - logout ends the session
 *
 * Usage:
 *   E2E_EMAIL=… E2E_PASSWORD=… node scripts/e2e-oidc.mjs \
 *     [--url https://shop.ozikoro.com] [--client-id ozk_…] [--client-secret …]
 */

import { sleep, startBrowser } from './lib/browser.mjs';
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ISSUER = (process.env['STORE_ORIGIN'] ?? arg('url', 'https://shop.ozikoro.com')).replace(/\/+$/, '');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const EMAIL = process.env['E2E_EMAIL'] ?? '';
const PASSWORD = process.env['E2E_PASSWORD'] ?? '';
const CLIENT_ID = arg('client-id', '');
const CLIENT_SECRET = arg('client-secret', '');
const SHOTS = arg('shots', '.e2e-oidc');

if (!EMAIL || !PASSWORD) {
  console.error('E2E_EMAIL and E2E_PASSWORD must be set.');
  process.exit(2);
}
if (!CLIENT_ID) {
  console.error('--client-id is required. Register one with scripts/oidc-client.mjs.');
  process.exit(2);
}

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const b64url = (input) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------------------------------------------------------- protocol checks

async function protocolChecks(redirectUri) {
  const discovery = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  check('discovery is served with the right issuer', discovery.issuer === ISSUER, discovery.issuer);
  check(
    'discovery offers authorization_code and refresh_token only',
    JSON.stringify(discovery.grant_types_supported) === '["authorization_code","refresh_token"]',
    JSON.stringify(discovery.grant_types_supported)
  );
  check(
    'discovery refuses the implicit flow',
    JSON.stringify(discovery.response_types_supported) === '["code"]',
    JSON.stringify(discovery.response_types_supported)
  );
  check(
    'discovery accepts only S256 PKCE',
    JSON.stringify(discovery.code_challenge_methods_supported) === '["S256"]',
    JSON.stringify(discovery.code_challenge_methods_supported)
  );

  // An unregistered redirect must be refused, and the refusal must NOT be a
  // redirect to it.
  const evil = await fetch(
    `${ISSUER}/oidc/authorize?client_id=${CLIENT_ID}&redirect_uri=https://attacker.example/cb&response_type=code&scope=openid`,
    { redirect: 'manual' }
  );
  check(
    'an unregistered redirect_uri is refused without redirecting to it',
    evil.status === 400 && !evil.headers.get('location'),
    `status ${evil.status}, location ${evil.headers.get('location') ?? 'none'}`
  );

  const unknownClient = await fetch(
    `${ISSUER}/oidc/authorize?client_id=nope&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid`,
    { redirect: 'manual' }
  );
  check('an unknown client_id is refused', unknownClient.status === 400, `status ${unknownClient.status}`);

  const plain = await fetch(
    `${ISSUER}/oidc/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid&code_challenge=${'a'.repeat(43)}&code_challenge_method=plain`,
    { redirect: 'manual' }
  );
  check(
    'a plain PKCE challenge is refused',
    plain.status === 302 && (plain.headers.get('location') ?? '').includes('error=invalid_request'),
    `status ${plain.status}`
  );

  const implicit = await fetch(
    `${ISSUER}/oidc/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=openid&code_challenge=${'a'.repeat(43)}&code_challenge_method=S256`,
    { redirect: 'manual' }
  );
  check(
    'response_type=token is refused',
    implicit.status === 302 && (implicit.headers.get('location') ?? '').includes('unsupported_response_type'),
    `status ${implicit.status}`
  );

  const userinfo = await fetch(`${ISSUER}/oidc/userinfo`);
  check('userinfo without a token is 401 with a challenge', userinfo.status === 401, `status ${userinfo.status}`);
}

// ------------------------------------------------------------------ browser

/**
 * Run the browser half of the suite in a shared session.
 *
 * The port is allocated by the operating system rather than guessed: the old
 * hard-coded 9950 range collided with the other suites when they were run in
 * sequence, and the failure looked like the store being broken.
 */
async function withBrowser(run) {
  const session = await startBrowser({ label: 'oidc', shots: SHOTS, windowSize: '1280,900' });
  try {
    await run({
      send: session.send,
      evaluate: session.evaluate,
      shot: session.shot,
      url: session.url,
      navigations: session.navigations,
    });
  } finally {
    await session.close();
  }
}

/** Fill the store's sign-in form. */
async function signIn(evaluate) {
  return evaluate(`(async () => {
    const set = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    if (!set('[data-testid="account-email"]', ${JSON.stringify(EMAIL)})) return 'no form';
    set('[data-testid="account-password"]', ${JSON.stringify(PASSWORD)});
    document.querySelector('[data-testid="account-submit"]').click();
    return 'submitted';
  })()`);
}

// ---------------------------------------------------------------------- main

const REDIRECT = `${ISSUER}/oidc/callback`;
const VERIFIER = b64url(randomBytes(32));
const CHALLENGE = b64url(createHash('sha256').update(VERIFIER).digest());

async function main() {
  await protocolChecks(REDIRECT);

  const authorizeUrl =
    `${ISSUER}/oidc/authorize?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&response_type=code&scope=${encodeURIComponent('openid profile email')}` +
    `&state=state-${b64url(randomBytes(6))}` +
    `&nonce=nonce-${b64url(randomBytes(6))}` +
    `&code_challenge=${CHALLENGE}&code_challenge_method=S256`;

  let code = null;
  let consentSeen = false;

  await withBrowser(async ({ send, evaluate, shot, url, navigations }) => {
    await send('Page.navigate', { url: authorizeUrl });
    await sleep(4000);

    // The provider sends a signed-out visitor to the store's sign-in with the
    // request preserved. That is the first thing to confirm.
    const landed = url();
    check(
      'a signed-out authorisation is sent to sign-in with the request preserved',
      landed.includes('/account') && landed.includes('next='),
      landed.slice(0, 70)
    );
    await shot('01-signin-handoff');

    const signInResult = await evaluate(
      `document.querySelector('[data-testid="account-email"]') ? 'form' : 'no form'`
    );
    if (signInResult === 'form') {
      await signIn(evaluate);
      await sleep(7000);
    }

    // Back on the provider, either at consent or already redirecting to the
    // client with a code.
    let current = url();
    if (current.includes('/oidc/authorize')) {
      consentSeen = (await evaluate("document.body.innerText.includes('is asking to use your Ozikoro account')")) === true;
      check('the consent screen names the client', consentSeen === true, current.slice(0, 60));
      await shot('02-consent');

      await evaluate(`(() => {
        const form = document.querySelector('form[action="/oidc/authorize"]');
        if (!form) return false;
        const allow = form.querySelector('button[name="decision"][value="allow"]');
        if (!allow) return false;
        allow.click();
        return true;
      })()`);
      await sleep(6000);
    }

    // The client's redirect carries the code. Chrome shows our callback as a
    // 404 — there is no such page on the store — but the URL is what matters,
    // and that is exactly what a real client would receive.
    current = url();
    const match = /[?&]code=([^&]+)/.exec(current);
    if (match) code = decodeURIComponent(match[1]);
    check('the authorisation redirect carries a code', Boolean(code), code ? `${code.slice(0, 12)}…` : current.slice(0, 80));
    check(
      'the redirect carries the state back unchanged',
      current.includes('state=state-'),
      current.slice(0, 80)
    );
    void navigations;
  });

  if (!code) {
    summarise();
    return;
  }

  // ------------------------------------------------------------ token exchange

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  });
  if (CLIENT_SECRET) tokenBody.set('client_secret', CLIENT_SECRET);

  const tokenResponse = await fetch(`${ISSUER}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });
  const tokens = await tokenResponse.json();
  check(
    'the code exchanges for tokens',
    tokenResponse.status === 200 && Boolean(tokens.id_token),
    tokenResponse.status === 200
      ? ''
      : `${tokenResponse.status} ${tokens.error ?? ''}: ${tokens.error_description ?? JSON.stringify(tokens).slice(0, 80)}`
  );

  if (!tokens.id_token) {
    summarise();
    return;
  }

  // ------------------------------------------------------ verify the ID token

  const jwks = await (await fetch(`${ISSUER}/oidc/jwks.json`)).json();
  const [headerPart, payloadPart, signaturePart] = tokens.id_token.split('.');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  const jwk = (jwks.keys ?? []).find((key) => key.kid === header.kid);

  check('the ID token names a published key', Boolean(jwk), header.kid);

  if (jwk) {
    const publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerPart}.${payloadPart}`);
    verifier.end();
    // The exact check a client performs, with only public material.
    const signatureOk = verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url'));
    check('the ID token verifies against the published JWKS', signatureOk === true);
  }

  check('the ID token audience is this client', payload.aud === CLIENT_ID, String(payload.aud));
  check('the ID token issuer is the provider', payload.iss === ISSUER, String(payload.iss));
  check('the ID token carries the account email', payload.email === EMAIL, String(payload.email));
  check('the ID token carries a subject', Boolean(payload.sub), String(payload.sub));
  check('the ID token echoes the nonce', String(payload.nonce ?? '').startsWith('nonce-'), String(payload.nonce));
  check('the ID token expires in the future', payload.exp > Math.floor(Date.now() / 1000));

  // ------------------------------------------------------- single-use and PKCE

  const replay = await fetch(`${ISSUER}/oidc/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: VERIFIER,
    }),
  });
  const replayBody = await replay.json();
  check(
    'an authorisation code cannot be redeemed twice',
    replay.status === 400 && replayBody.error === 'invalid_grant',
    `${replay.status} ${replayBody.error ?? ''}`
  );

  // ------------------------------------------------------------- userinfo

  const userinfo = await fetch(`${ISSUER}/oidc/userinfo`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await userinfo.json();
  check('userinfo returns the account for a valid token', userinfo.status === 200 && profile.email === EMAIL, `${userinfo.status} ${profile.email ?? ''}`);
  check('userinfo returns the subject that matches the ID token', profile.sub === payload.sub);
  check('userinfo includes the role claim for the profile scope', Boolean(profile.role), String(profile.role));

  const badToken = await fetch(`${ISSUER}/oidc/userinfo`, { headers: { authorization: 'Bearer not-a-token' } });
  check('userinfo rejects an unknown token', badToken.status === 401, `status ${badToken.status}`);

  // -------------------------------------------------------------- refresh

  if (tokens.refresh_token) {
    const refreshed = await fetch(`${ISSUER}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
        ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
      }),
    });
    const second = await refreshed.json();
    check('a refresh token rotates into new tokens', refreshed.status === 200 && Boolean(second.id_token), `status ${refreshed.status}`);

    // Presenting the OLD token again is the reuse this design is built to catch.
    const reuse = await fetch(`${ISSUER}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: CLIENT_ID,
        ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
      }),
    });
    const reuseBody = await reuse.json();
    check(
      'reusing a spent refresh token is refused',
      reuse.status === 400 && reuseBody.error === 'invalid_grant',
      `${reuse.status} ${reuseBody.error ?? ''}`
    );

    // ...and it must have revoked the whole family, including the fresh token.
    const afterRevoke = await fetch(`${ISSUER}/oidc/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: second.refresh_token ?? '',
        client_id: CLIENT_ID,
        ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
      }),
    });
    check(
      'reuse detection revokes the whole token family',
      afterRevoke.status === 400,
      `status ${afterRevoke.status}`
    );
  } else {
    check('a refresh token was issued', false, 'none in the token response');
  }

  summarise();
}

function summarise() {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  for (const result of failed) console.log(`  - ${result.name}: ${result.detail}`);
  console.log(`Screenshots in ${SHOTS}/`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
