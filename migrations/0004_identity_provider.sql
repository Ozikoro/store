-- Ozikoro identity provider.
--
-- WHY AN IDENTITY PROVIDER LIVING IN THE STORE
--
-- Three platforms, three account tables, and the owner's requirement is one
-- account across all of them. Nothing federates today: ozikoro.com is WordPress
-- with no identity plugin, ozituma.com has its own `account` table, and the shop
-- has this one. The account stores were deliberately separated once before,
-- when a bridge between ozituma and a courses site was deleted for leaking its
-- shared secret into a browser bundle.
--
-- So identity is centralised rather than mirrored. The shop is the identity
-- OWNER because it is the only one of the three that can be deployed from this
-- repository; the other two become OIDC clients. That is an implementation
-- fact, not a claim about the brand: ozikoro.com is the parent, and if the
-- archive ever grows an account system of its own, this provider can be handed
-- over — the protocol is the interface, so the clients do not change.
--
-- WHAT IS STORED
--
--   oauth_clients        the registered clients (one per platform)
--   auth_codes           single-use, short-lived, PKCE-bound
--   refresh_tokens       long-lived, rotated on use, hashed at rest
--   signing_keys         the RSA key the provider signs ID tokens with
--
-- Every token value in this schema is stored as a SHA-256 digest, never raw. A
-- database dump is therefore not a set of working credentials.

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------- clients

CREATE TABLE IF NOT EXISTS oauth_clients (
  id                TEXT PRIMARY KEY,
  -- The `client_id` the client sends. Public, not a secret.
  client_id         TEXT NOT NULL UNIQUE,
  -- NULL for a public client (a WordPress plugin or a Next.js app that cannot
  -- keep a secret). A confidential client stores a SHA-256 of its secret.
  client_secret_hash TEXT,
  name              TEXT NOT NULL,
  -- Comma-free JSON array of absolute redirect URIs. An exact match is required
  -- at authorisation time: allowing a prefix match is how an open redirect
  -- becomes a token leak.
  redirect_uris     TEXT NOT NULL,
  -- Space-separated. `openid` is required; `profile` and `email` add claims.
  scopes            TEXT NOT NULL DEFAULT 'openid profile email',
  -- A client that cannot keep a secret must use PKCE. Recorded so the
  -- authorisation endpoint can refuse a plain challenge from a confidential
  -- client and require PKCE from a public one.
  is_public         INTEGER NOT NULL DEFAULT 1,
  -- Comma-free JSON array of post-logout redirect URIs.
  post_logout_uris  TEXT NOT NULL DEFAULT '[]',
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --------------------------------------------------------------- auth codes

CREATE TABLE IF NOT EXISTS auth_codes (
  -- SHA-256 of the code that was issued.
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  customer_id       TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  redirect_uri      TEXT NOT NULL,
  -- The PKCE challenge, and the method. `plain` is refused at issue time; only
  -- S256 is accepted, because `plain` offers no protection against the attack
  -- PKCE exists to stop.
  code_challenge    TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  scope             TEXT NOT NULL DEFAULT 'openid',
  -- The `nonce` from the request, echoed into the ID token so the client can
  -- detect a replayed token.
  nonce             TEXT NOT NULL DEFAULT '',
  expires_at        TEXT NOT NULL,
  -- Set the moment it is redeemed. A second redemption is refused, which is what
  -- makes an intercepted code useless.
  consumed_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_expiry ON auth_codes(expires_at);

-- ------------------------------------------------------------ refresh tokens

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                TEXT PRIMARY KEY,
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  customer_id       TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL DEFAULT 'openid',
  expires_at        TEXT NOT NULL,
  -- Rotation: a used token is marked and a replacement issued. If a CONSUMED
  -- token is presented again, something has leaked, so every token in that
  -- family is revoked. `family_id` is what makes that possible.
  family_id         TEXT NOT NULL,
  consumed_at       TEXT,
  revoked_at        TEXT,
  replaced_by       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_customer ON refresh_tokens(customer_id);

-- ------------------------------------------------------------- signing keys

CREATE TABLE IF NOT EXISTS signing_keys (
  id                TEXT PRIMARY KEY,   -- the `kid`
  algorithm         TEXT NOT NULL DEFAULT 'RS256',
  -- PKCS#8 private key, PEM. Kept in D1 rather than in a Worker secret so a key
  -- can be ROTATED without a redeploy: the JWKS endpoint publishes every active
  -- key, so rotating is an insert, not an outage.
  private_key_pem   TEXT NOT NULL,
  public_jwk        TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at        TEXT
);

-- ------------------------------------------------------------------ consents
-- What a person agreed to let a client see. Kept so the consent screen can be
-- skipped on a later request for the same scopes, and so a person can see and
-- revoke what they have granted.
CREATE TABLE IF NOT EXISTS oauth_consents (
  id                TEXT PRIMARY KEY,
  customer_id       TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  scope             TEXT NOT NULL,
  granted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at        TEXT,
  UNIQUE (customer_id, client_id)
);

-- ------------------------------------------------------------- access tokens
-- Opaque and hashed at rest, rather than a second JWT.
--
-- An access token is checked on EVERY userinfo call, so it has to be revocable
-- the moment an account is closed or a grant is withdrawn. A self-contained JWT
-- cannot be, and a JWT carrying the profile claims would also put a person's
-- name and email inside a string that clients log. One indexed lookup is the
-- cheaper trade.
CREATE TABLE IF NOT EXISTS access_tokens (
  id                TEXT PRIMARY KEY,   -- SHA-256 of the token
  client_id         TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  customer_id       TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL DEFAULT 'openid',
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_customer ON access_tokens(customer_id);
