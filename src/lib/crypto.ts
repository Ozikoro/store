/**
 * Password hashing and token generation.
 *
 * `node:crypto` is available in the Workers runtime through the `nodejs_compat`
 * flag, which this project sets. scrypt is used rather than a hand-rolled hash:
 * it is memory-hard, it is in the standard library, and there is no dependency
 * to keep patched.
 *
 * Two rules are enforced here and nowhere else:
 *   - a password is never stored, only a salted scrypt hash;
 *   - a comparison is constant-time, so a wrong password cannot be discovered
 *     one byte at a time by measuring how long the answer took.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

const KEY_BYTES = 64;

export interface PasswordHash {
  hash: string;
  salt: string;
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_BYTES);
  return { hash: derived.toString('hex'), salt };
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed record: a corrupted row must
 * fail a login, not crash the endpoint. The length check before
 * `timingSafeEqual` is required because it throws on mismatched lengths, and
 * that throw would itself be a distinguishable signal.
 */
export async function verifyPassword(
  password: string,
  stored: PasswordHash | { hash: string | null; salt: string | null }
): Promise<boolean> {
  const hash = stored.hash;
  const salt = stored.salt;
  if (!hash || !salt) return false;
  try {
    const derived = await scrypt(password, salt, KEY_BYTES);
    const expected = Buffer.from(hash, 'hex');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

/** A URL-safe random token, for session cookies and one-time links. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * The lookup key for a session. Only this digest is stored, so a database dump
 * does not hand an attacker a working session cookie. SHA-256 with no salt is
 * correct here: the input is 256 bits of random, so there is nothing to guess.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A short, human-quotable id fragment. Not a secret, not a primary key. */
export function shortId(length = 8): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index] ?? 0;
    out += alphabet[byte % alphabet.length];
  }
  return out;
}
