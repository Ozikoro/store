import { describe, expect, it } from 'vitest';

import { MAX_ATTEMPTS, nextAttemptMinutes } from '../lib/mail';
import { mailConfig } from '../lib/mailer';

/**
 * The rules that decide whether a customer is ever told.
 *
 * WHY THESE ARE UNIT TESTS
 *
 * The outbox exists because email fails: providers have outages, addresses are
 * wrong, a domain is not verified. The behaviour that matters is what happens
 * NEXT — whether a failure is retried, how soon, and when it stops. Getting that
 * wrong is silent in both directions:
 *
 *   * too eager and a real message is buried under repeated attempts
 *   * too lax and a customer is never told, with the queue reporting success
 *
 * None of it needs a network or a database, which is why it is asserted here
 * rather than in a browser.
 */

describe('the retry schedule', () => {
  it('retries soonest after the first failure', () => {
    // The first attempt has just failed, so `attempts` is 1.
    expect(nextAttemptMinutes(1)).toBe(1);
  });

  it('waits longer after each further failure', () => {
    const waits = [1, 2, 3, 4, 5].map((attempt) => nextAttemptMinutes(attempt));
    for (let i = 1; i < waits.length; i += 1) {
      expect(waits[i]).toBeGreaterThan(waits[i - 1] ?? 0);
    }
    expect(waits).toEqual([1, 5, 30, 120, 480]);
  });

  it('does not grow without bound past the last attempt', () => {
    // A message that somehow exceeds the maximum must not be scheduled into the
    // next century; the final interval is the ceiling.
    expect(nextAttemptMinutes(MAX_ATTEMPTS)).toBe(480);
    expect(nextAttemptMinutes(MAX_ATTEMPTS + 10)).toBe(480);
    expect(nextAttemptMinutes(999)).toBe(480);
  });

  it('treats a zero or negative attempt count as the first attempt', () => {
    // `attempts` is 0 before the first send, so a failure recorded without the
    // increment would otherwise schedule `undefined`.
    expect(nextAttemptMinutes(0)).toBe(1);
    expect(nextAttemptMinutes(-3)).toBe(1);
  });

  it('never returns a value that would retry immediately in a loop', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(nextAttemptMinutes(attempt)).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(nextAttemptMinutes(attempt))).toBe(true);
    }
  });

  it('spreads the maximum attempts over hours, not minutes', () => {
    const total = Array.from({ length: MAX_ATTEMPTS }, (_, i) => nextAttemptMinutes(i + 1)).reduce(
      (sum, minutes) => sum + minutes,
      0
    );
    // 1 + 5 + 30 + 120 + 480 = 636 minutes, about ten and a half hours. Long
    // enough to ride out an outage, short enough that somebody notices the same
    // day.
    expect(total).toBe(636);
    expect(total / 60).toBeGreaterThan(6);
  });

  it('stops after a bounded number of attempts', () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});

describe('which provider the configuration selects', () => {
  it('sends nothing, and says so, with no key at all', () => {
    const config = mailConfig({});
    expect(config.provider).toBe('none');
    expect(config.apiKey).toBe('');
  });

  it('uses Resend once a key exists', () => {
    const config = mailConfig({ RESEND_API_KEY: 're_test_123' });
    expect(config.provider).toBe('resend');
    expect(config.apiKey).toBe('re_test_123');
  });

  it('CAPTURE WINS over a real key, so a test can never send to a person', () => {
    // The whole point of capture mode: if both are present, nothing leaves the
    // building. A test that sends real email to a real address is a bug.
    const config = mailConfig({ RESEND_API_KEY: 're_test_123', MAIL_CAPTURE: '1' });
    expect(config.provider).toBe('capture');
    // The key is not even carried, so it cannot leak through this object.
    expect(config.apiKey).toBe('');
  });

  it('defaults the From and Reply-To so a misconfiguration is still a valid sender', () => {
    const config = mailConfig({ RESEND_API_KEY: 're_test_123' });
    expect(config.from).toContain('@');
    expect(config.replyTo).toContain('@');
  });

  it('honours an explicit From, which must be a verified domain', () => {
    const config = mailConfig({ RESEND_API_KEY: 'k', MAIL_FROM: 'Shop <shop@example.org>' });
    expect(config.from).toBe('Shop <shop@example.org>');
  });
});
