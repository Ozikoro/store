# Ozikoro single sign-on

One account across **ozikoro.com**, **ozituma.com** and **shop.ozikoro.com**.

The identity provider is the store's own account service, because it is the only
one of the three that can be deployed from a repository. The other two are OIDC
clients. That is an implementation fact, not a claim about the brand: the
protocol is the interface, so if the archive ever grows an account system of its
own, the provider can be handed over and **no client changes**.

---

## What exists, and what does not

| | |
|---|---|
| **Provider** | `https://shop.ozikoro.com` |
| **Discovery** | https://shop.ozikoro.com/.well-known/openid-configuration |
| **JWKS** | https://shop.ozikoro.com/oidc/jwks.json |
| **Signing** | RS256. Clients hold only the PUBLIC key, so a compromised client cannot mint tokens. |
| **Flows** | `authorization_code` and `refresh_token`. The implicit flow is not offered. |
| **PKCE** | `S256` only. `plain` is refused. |

### What is verified, and by which test

`node scripts/e2e-oidc.mjs` — **29 checks, all passing against production**. It
is a real browser because the sign-in is a CSRF-protected server function that
curl cannot complete, and faking a session would test the test.

It proves, among other things: discovery's issuer matches the tokens issued; an
unregistered `redirect_uri` is refused **without redirecting to it**; a `plain`
PKCE challenge is refused; an ID token **verifies against the published JWKS**
with only public material; a code **cannot be redeemed twice**; a wrong PKCE
verifier is refused; userinfo returns the account; and **reusing a spent refresh
token revokes the whole family**.

---

## Registered clients

| Client | `client_id` | Type | Redirect URI |
|---|---|---|---|
| Ozikoro Store | `ozk_4daaae6a6b6d7cbb48` | public | `https://shop.ozikoro.com/oidc/callback` |
| Ozikoro Archive | `ozk_a57366560216b7e227` | confidential | `https://ozikoro.com/oidc/callback` |
| Ozituma Dictionary | `ozk_dffb288bd4e6f5be02` | confidential | `https://ozituma.com/api/auth/oidc/callback` |

Client secrets were printed once by `scripts/oidc-client.mjs` and stored only as
a SHA-256. **They are not in this file, not in the repository and not in the
database in readable form.** Put each one in its platform's *server* environment.

> The previous bridge between two Ozikoro sites was deleted because its shared
> secret was a `VITE_`-prefixed variable, which inlined it into the browser
> bundle and let anyone mint accounts. A client secret must never be reachable
> from a browser.

---

## What each platform has to do

Nothing on the provider side is missing. Each client needs an OIDC client
library wired to three calls.

### ozikoro.com (WordPress)

**No identity plugin is installed** — there is no OAuth, OIDC or JWT namespace on
the site today, so this is greenfield. WordPress core has Application Passwords,
which authenticate a *server* to the REST API, but that is not single sign-on: it
cannot accept a browser arriving with an ID token.

Two viable routes:

1. **A plugin**, if one is approved. It needs to speak generic OIDC, not
   WordPress.com OAuth. Configure it with the discovery URL and the client id and
   secret, and map `email` and `preferred_username` onto the WordPress user.
2. **A small mu-plugin** — roughly 150 lines: register
   `/oidc/callback`, exchange the code server-side, verify the ID token against
   the JWKS, then call `wp_set_auth_cookie()`. This is the route to prefer if no
   suitable plugin is already trusted on the site, because it has no third-party
   code in the sign-in path.

Whichever is chosen, `sub` is the stable identifier. Keying WordPress users on
`sub` rather than on the email address is what keeps the link correct when
somebody changes their address.

### ozituma.com (Next.js)

The dictionary already has its own `account` table and its own scrypt sign-in at
`/api/auth/[action]`. Adding `POST /api/auth/oidc/callback` is the whole change:

1. Exchange the code at the token endpoint with the client secret.
2. Verify the ID token against the JWKS.
3. Find or create the local `account` row by `sub`, keeping the email in step.
4. Issue the existing `ozituma_session` cookie, exactly as the password route
   already does.

**The existing password sign-in can stay.** It is not in conflict: OIDC becomes a
second way in, and the account row is the same row. Retiring the password path is
a separate decision.

### shop.ozikoro.com

Already done. The store signs in through its own provider, deliberately: if the
store used a private path, there would be two sign-in mechanisms and the one
exercised least would rot. Exercising the public protocol on every real sign-in
means a regression breaks the store immediately rather than only the
integrations.

---

## The limitations, stated plainly

**Propagation is not federation.** Registering a new account happens once, at the
provider. A password changed at the provider is the password everywhere. But a
*client* that still has its own password form — as ozituma does today — will
accept the old password until that form is removed or pointed at the provider.

**Sessions are per-platform.** Signing in on ozikoro.com does not, by itself,
create a session on the shop; each client completes its own OIDC exchange the
first time. What is shared is the *account*, and once each client has done one
exchange the person is signed in on all three. Making a single session span all
three domains would require the cookie to be on `.ozikoro.com` and would mean
every platform trusting one cookie — a larger decision, and a worse one: it puts
every platform's security at the level of the weakest.

**`email_verified` is reported as true** because an account exists only once
somebody has registered with that address. If verification by email ever becomes
a step, that claim must be read from the account rather than assumed, and this
note is where that starts.

**A client that leaks its secret** should be deactivated:
`node scripts/oidc-client.mjs deactivate --client-id ozk_…`. Existing refresh
tokens for it stay valid until they expire; delete them if the leak is real.

---

## Operating it

```bash
# register a client (secret shown once)
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
  node scripts/oidc-client.mjs register --name "Ozituma Dictionary" \
    --redirect https://ozituma.com/api/auth/oidc/callback \
    --post-logout https://ozituma.com/ --confidential

# see what is registered
node scripts/oidc-client.mjs list

# run the protocol suite
E2E_EMAIL=… E2E_PASSWORD=… node scripts/e2e-oidc.mjs --client-id ozk_…
```

### Key rotation

Signing keys live in D1, not in a Worker secret, so a rotation needs no redeploy.
Insert a new key; the JWKS publishes every active key, so tokens signed by the
old one keep verifying. Retire the old key once the longest ID token lifetime
(10 minutes) plus the JWKS cache (1 hour) has passed.

### Storage

Every token value is stored as a SHA-256 digest: authorisation codes, refresh
tokens, access tokens and session cookies. A database dump is not a set of
working credentials. Refresh tokens rotate on use and carry a `family_id`, so a
reused token revokes the entire family — a forced re-login is cheap, and serving
both a person and an attacker is not.
