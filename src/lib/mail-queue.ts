/**
 * The send loop.
 *
 * Claims due messages one at a time, hands each to the provider, and records the
 * outcome. It is deliberately small: all the judgement — how many attempts, how
 * long to wait, what counts as permanent — lives in `mail.ts` and `mailer.ts`,
 * and this only sequences it.
 *
 * WHERE IT RUNS
 *
 * Two callers, and they cover different failures:
 *
 *   * The webhook and the settlement path call `flush()` inline, so the ordinary
 *     case delivers immediately rather than waiting for a cron.
 *   * `scripts/flush-outbox.mjs` drains the queue, which is what catches anything
 *     the inline attempt could not deliver — a provider outage, a message queued
 *     before a key existed, or an isolate evicted mid-send.
 *
 * A cron trigger on the Worker would be the third, and is worth adding once a
 * provider is chosen; until then it would only retry into a provider that is not
 * configured.
 */

import { env } from './env';
import {
  claimForSending,
  dueMessages,
  markFailed,
  markSent,
  type OutboxRow,
} from './mail';
import { mailConfig, sendMail } from './mailer';
import { recordAudit } from './audit';


export interface FlushReport {
  attempted: number;
  sent: number;
  failed: number;
  /** Set when there is nothing to send with, so the caller can say so once. */
  provider: string;
  errors: string[];
}

/**
 * Try to deliver everything that is due.
 *
 * `limit` bounds the work in one request: a Worker has a CPU budget and the
 * gateway is waiting, so a large backlog is drained by the script rather than by
 * holding a payment response open.
 */
export async function flush(limit = 10): Promise<FlushReport> {
  const config = mailConfig(env() as unknown as Record<string, string | undefined>);
  const report: FlushReport = { attempted: 0, sent: 0, failed: 0, provider: config.provider, errors: [] };

  if (config.provider === 'none') {
    // Nothing to do, and NOT an error: an unconfigured provider is a valid state
    // in which the outbox simply accumulates. Saying so once beats logging an
    // identical failure for every message on every request.
    return report;
  }

  const due = await dueMessages(limit);
  for (const candidate of due) {
    // Claim first. Between the read above and here another caller may have taken
    // it, and claiming is what makes that impossible to get wrong.
    const message = await claimForSending(candidate.id);
    if (!message) continue;

    report.attempted += 1;
    const result = await sendMail(config, message);

    if (result.ok) {
      await markSent(message.id, result.providerMessageId);
      report.sent += 1;
      continue;
    }

    report.failed += 1;
    report.errors.push(`${message.template} → ${message.to_email}: ${result.message}`);
    // A permanent failure settles as `failed` immediately. It is recorded, never
    // deleted: somebody has to know the customer was never told.
    await markFailed(message.id, result.message, result.permanent === true);
  }

  return report;
}

/**
 * Flush, and record it only when something did not go out.
 *
 * An audit row per delivered email would bury the entries that matter — price
 * changes, refunds, role changes — under routine success. A FAILURE is worth a
 * row, because that is the case somebody has to act on.
 */
export async function flushAndAudit(entityId: string): Promise<FlushReport> {
  const report = await flush();
  if (report.failed > 0) {
    await recordAudit({
      actor: null,
      action: 'mail.delivery_failed',
      entity: 'product',
      entityId,
      after: { attempted: report.attempted, failed: report.failed, provider: report.provider, errors: report.errors.slice(0, 3) },
    });
  }
  return report;
}
