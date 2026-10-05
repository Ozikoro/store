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
  /**
   * Contact messages per IP.
   *
   * THIS WAS 5 AN HOUR, AND THAT IS TOO FEW. The limit exists to stop a script
   * filling the inbox, but the key is an IP address and a whole office, a
   * coworking space, a campus or a mobile carrier's NAT shares ONE. Five
   * messages an hour between everyone behind that address means the sixth person
   * to write to the shop is refused, and a legitimate customer has no recourse
   * and no idea why.
   *
   * The per-EMAIL limit below is what actually stops a nuisance — a script
   * hammering the form usually uses one address, or no valid one — so this one
   * can be generous. Twenty an hour is still a script's submissions failing long
   * before they amount to a mailbomb.
   */
  contact: { limit: 20, windowSeconds: 60 * 60 },
  /**
   * Contact messages per sender address.
   *
   * The reason this exists separately: keying only on IP either blocks a shared
   * office or, if raised far enough to avoid that, lets one person send fifty
   * messages. Keyed on the address, a nuisance sender is stopped precisely and
   * nobody else is affected.
   */
  contactPerEmail: { limit: 4, windowSeconds: 60 * 60 },
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

/**
 * Remove buckets whose window has passed.
 *
 * WHY THIS IS NEEDED
 *
 * Every distinct key leaves a row forever: an IP that visited once, an email
 * that tried a password once. The counters are only meaningful WITHIN their
 * window — a row whose window has rolled over is reset on next use — so a row
 * older than its own window is dead weight, and it accumulates one per visitor.
 *
 * That is the same shape of leak as the carts table, and it is worth fixing
 * before it is a problem rather than after. A bucket is safe to delete once
 * `window_start` is older than the longest window, because any request for that
 * key afterwards creates a fresh row and counts from one — which is exactly what
 * it would have done anyway.
 */
export async function pruneRateLimits(): Promise<number> {
  const longestWindowSeconds = Math.max(
    ...Object.values(RATE_LIMITS).map((rule) => rule.windowSeconds)
  );
  const result = await db()
    .prepare(`DELETE FROM rate_limits WHERE window_start <= datetime('now', '-' || ?1 || ' seconds')`)
    .bind(longestWindowSeconds)
    .run();
  return (result.meta?.['changes'] as number) ?? 0;
}
