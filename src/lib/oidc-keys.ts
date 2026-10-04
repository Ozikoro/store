/**
 * Token signing and verification for the identity provider.
 *
 * RS256, not HS256. With a shared secret every client could MINT tokens as well
 * as verify them, so one compromised client would compromise every account on
 * every platform. With an asymmetric key the clients hold only the PUBLIC half:
 * they can verify, and cannot forge.
 *
 * The key lives in D1 rather than in a Worker secret so it can be rotated
 * without a redeploy — the JWKS endpoint publishes every active key, so a
 * rotation is an insert followed by a grace period, not an outage.
 *
 * `node:crypto` is available in the Workers runtime under `nodejs_compat`.
 */

import { createSign, createVerify, generateKeyPairSync, createPublicKey, randomBytes } from 'node:crypto';
import { db } from './env';
import { sha256 } from './crypto';

export interface SigningKey {
  id: string;
  algorithm: string;
  private_key_pem: string;
  public_jwk: string;
  is_active: number;
  created_at: string;
  retired_at: string | null;
}

export interface Jwk {
  kty: string;
  n: string;
  e: string;
  alg: string;
  use: string;
  kid: string;
}

function base64url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The currently active signing key, created on first use.
 *
 * Creating on demand rather than at deploy time means a fresh database is
 * usable immediately and there is no "you forgot to seed the key" failure mode.
 * The race between two isolates generating a key at once is harmless: the second
 * insert is a different `kid`, and the JWKS publishes both, so a token signed by
 * either verifies.
 */
export async function activeSigningKey(): Promise<SigningKey> {
  const existing = await db()
    .prepare(`SELECT * FROM signing_keys WHERE is_active = 1 AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .first<SigningKey>();
  if (existing) return existing;

  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const kid = base64url(randomBytes(12));
  const jwk = createPublicKey(publicKey).export({ format: 'jwk' }) as { n: string; e: string };
  const publicJwk: Jwk = { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid };

  await db()
    .prepare(
      `INSERT INTO signing_keys (id, algorithm, private_key_pem, public_jwk) VALUES (?1, 'RS256', ?2, ?3)`
    )
    .bind(kid, privateKey, JSON.stringify(publicJwk))
    .run();

  const created = await db().prepare('SELECT * FROM signing_keys WHERE id = ?1').bind(kid).first<SigningKey>();
  if (!created) throw new Error('The signing key could not be stored.');
  return created;
}

/** Every key a client should accept, newest first. */
export async function publishedKeys(): Promise<Jwk[]> {
  const result = await db()
    .prepare(
      `SELECT public_jwk FROM signing_keys
        WHERE retired_at IS NULL
        ORDER BY created_at DESC`
    )
    .all<{ public_jwk: string }>();
  const keys: Jwk[] = [];
  for (const row of result.results ?? []) {
    try {
      keys.push(JSON.parse(row.public_jwk) as Jwk);
    } catch {
      // A malformed row must not take the whole JWKS down: clients fetch this on
      // every verification, so an empty list would be an outage.
      console.error('[oidc] a stored public JWK could not be parsed');
    }
  }
  if (!keys.length) {
    // Nothing published yet: create the first key so this endpoint is never
    // empty during a cold start.
    const key = await activeSigningKey();
    keys.push(JSON.parse(key.public_jwk) as Jwk);
  }
  return keys;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  auth_time?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  role?: string;
}

/**
 * Sign a JWT.
 *
 * The header carries the `kid` so a client with several published keys knows
 * which one to verify against — without it, a rotation would be a guess.
 */
export async function signJwt(claims: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  const key = await activeSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: key.id };
  const payload = { iat: now, exp: now + ttlSeconds, ...claims };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key.private_key_pem);
  return `${signingInput}.${base64url(signature)}`;
}

/** One-time codes and refresh tokens: 256 bits, and only the digest is stored. */
export function newOpaqueToken(): { value: string; digest: string } {
  const value = base64url(randomBytes(32));
  return { value, digest: sha256(value) };
}

export interface VerifiedJwt {
  ok: true;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/**
 * Verify a JWT this provider issued.
 *
 * Used by the provider's own userinfo endpoint, so it is deliberately strict:
 * the signature must check out against a PUBLISHED key, and the expiry must not
 * have passed. It is not a general-purpose verifier and does not try to be.
 */
export async function verifyJwt(token: string): Promise<VerifiedJwt | { ok: false; reason: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not a JWT' };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as Record<string, unknown>;
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'unparseable' };
  }

  const keys = await publishedKeys();
  const key = keys.find((candidate) => candidate.kid === header['kid']) ?? null;
  if (!key) return { ok: false, reason: 'unknown key' };

  const publicKey = createPublicKey({
    key: { kty: key.kty, n: key.n, e: key.e },
    format: 'jwk',
  });

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerPart}.${payloadPart}`);
  verifier.end();
  const signature = Buffer.from(signaturePart, 'base64url');
  if (!verifier.verify(publicKey, signature)) return { ok: false, reason: 'bad signature' };

  const exp = typeof payload['exp'] === 'number' ? payload['exp'] : 0;
  if (exp <= Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };

  return { ok: true, header, payload };
}
