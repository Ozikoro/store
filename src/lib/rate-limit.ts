/**
 * Rate limiting.
 *
 * Account and checkout endpoints are rate limited because they are the two
 * places where an unauthenticated stranger can make the store do expensive work:
 * guessing passwords, or creating orders and payment intents.
 *
 * The counter lives in D1 rather than in memory. A Worker has no shared memory
 * between isolates and none at all between colos, so an in-memory limiter would
 * simply not limit anything once the traffic is real.
 *
 * The implementation is a fixed window, which is the honest trade: it is not the
 * most precise algorithm, but it is one row and one upsert, and it cannot be
 * defeated by opening a second connection.
 */

import { db } from './env';

export interface RateLimitRule {
  /** Buckets per window. */
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  /** Sign-in attempts per email+IP. */
  login: { limit: 8, windowSeconds: 15 * 60 },
  /** Registrations per IP. */
  register: { limit: 6, windowSeconds: 60 * 60 },
  /** Checkout initialisations per IP. */
  checkout: { limit: 20, windowSeconds: 15 * 60 },
  /** Contact messages per IP. */
  contact: { limit: 5, windowSeconds: 60 * 60 },
  /** Password reset requests per email. */
  passwordReset: { limit: 5, windowSeconds: 60 * 60 },
  /** Read-only search, generous: this is browsing, not abuse. */
  search: { limit: 240, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function windowStart(now: Date, windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Consume one unit from a bucket.
 *
 * An upsert that resets the counter when the stored window has rolled over, in a
 * single statement, so two concurrent requests cannot both read the old count
 * and both decide they are under the limit.
 */
export async function consumeRateLimit(
  key: string,
  rule: RateLimitRule,
  now: Date = new Date()
): Promise<RateLimitResult> {
  const start = windowStart(now, rule.windowSeconds);
  const startIso = start.toISOString();

  const row = await db()
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start)
       VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.count + 1 ELSE 1 END,
         window_start = CASE WHEN rate_limits.window_start = ?2 THEN rate_limits.window_start ELSE ?2 END
       RETURNING count, window_start`
    )
    .bind(key, startIso)
    .first<{ count: number; window_start: string }>();

  const count = row?.count ?? 1;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((start.getTime() + rule.windowSeconds * 1000 - now.getTime()) / 1000)
  );

  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds,
  };
}

export class RateLimitError extends Error {
  readonly status = 429;
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = 'Too many attempts. Please wait and try again.') {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Throwing guard for use inside server functions. */
export async function enforceRateLimit(
  key: string,
  rule: RateLimitRule,
  now: Date = new Date()
): Promise<void> {
  const result = await consumeRateLimit(key, rule, now);
  if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
}

export async function clearRateLimit(key: string): Promise<void> {
  await db().prepare('DELETE FROM rate_limits WHERE key = ?1').bind(key).run();
}
