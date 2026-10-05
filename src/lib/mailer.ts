/**
 * Delivering what the outbox has recorded.
 *
 * THE PROVIDER IS CHOSEN BY CONFIGURATION, NOT BY CODE
 *
 * A store must be able to run without an email provider — the messages queue and
 * wait, which is strictly better than losing them. When a key exists, the
 * adapter below is the only thing that changes hands.
 *
 * WHY RESEND IS THE DEFAULT
 *
 * It is one HTTP POST with a bearer token, which is all a Worker can do anyway,
 * and it has a free tier that covers a small shop. It is a DEFAULT, not a
 * dependency: `MAIL_PROVIDER=capture` records what would have been sent without
 * sending it, which is what the test suite uses, and a second provider is a
 * function in this file rather than a change anywhere else.
 */

import type { OutboxRow } from './mail';

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; message: string; /** true when retrying cannot help. */ permanent?: boolean };

export interface MailConfig {
  provider: 'resend' | 'capture' | 'none';
  apiKey: string;
  /** The From address. Must be a domain the provider has verified. */
  from: string;
  replyTo: string;
}

/**
 * Read the configuration from the environment.
 *
 * `capture` is chosen when `MAIL_CAPTURE` is set, so the test suite can exercise
 * the whole pipeline — queue, claim, attempt, mark — without a provider and
 * without sending anything to a real person.
 */
export function mailConfig(env: Record<string, string | undefined>): MailConfig {
  const apiKey = env['RESEND_API_KEY'] ?? '';
  const capture = env['MAIL_CAPTURE'] === '1';
  const from = env['MAIL_FROM'] ?? 'Ozikoro Store <store@ozikoro.com>';
  const replyTo = env['MAIL_REPLY_TO'] ?? 'hello@ozikoro.com';

  if (capture) return { provider: 'capture', apiKey: '', from, replyTo };
  if (apiKey) return { provider: 'resend', apiKey, from, replyTo };
  return { provider: 'none', apiKey: '', from, replyTo };
}

/**
 * A provider that records instead of sending.
 *
 * This is not a mock in the test-only sense: it is a supported configuration, so
 * a shop can run with the outbox visible and nothing leaving the building —
 * useful while the wording is being settled.
 */
const captured: Array<{ to: string; subject: string; at: string }> = [];

export function capturedMessages(): ReadonlyArray<{ to: string; subject: string; at: string }> {
  return captured;
}

export function clearCaptured(): void {
  captured.length = 0;
}

/**
 * Send one message.
 *
 * A failure is classified, because the retry policy depends on it. A 422 from the
 * provider means the address is unusable or the domain is not verified; retrying
 * that five times over half a day only delays the moment somebody notices. A 429
 * or a 5xx is transient and worth another go. Getting this wrong in the
 * direction of "always permanent" loses real mail; in the direction of "always
 * transient" it buries it.
 */
export async function sendMail(config: MailConfig, message: OutboxRow): Promise<SendResult> {
  if (config.provider === 'none') {
    return {
      ok: false,
      message: 'No email provider is configured. Set RESEND_API_KEY, or MAIL_CAPTURE=1 to record without sending.',
      permanent: true,
    };
  }

  if (config.provider === 'capture') {
    captured.push({ to: message.to_email, subject: message.subject, at: new Date().toISOString() });
    return { ok: true, providerMessageId: `capture:${message.id}` };
  }

  let response: Response;
  try {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to_email],
        reply_to: config.replyTo,
        subject: message.subject,
        text: message.body_text,
        html: message.body_html || undefined,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // A timeout or a DNS failure is transient by nature.
    return { ok: false, message: `Could not reach the mail provider: ${error instanceof Error ? error.message : 'unknown'}` };
  }

  const body = (await response.json().catch(() => null)) as { id?: string; message?: string; error?: { message?: string } } | null;

  if (!response.ok) {
    const detail = body?.message ?? body?.error?.message ?? `HTTP ${response.status}`;
    // 4xx except 408 and 429 will not improve by trying again.
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
    return { ok: false, message: detail, permanent };
  }

  return { ok: true, providerMessageId: body?.id ?? null };
}
