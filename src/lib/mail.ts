/**
 * Outbound email: what the store owes the customer, written down before sending.
 *
 * THE ORDER OF OPERATIONS HERE IS THE DESIGN
 *
 * `queue()` writes a row and sends nothing. Delivery is a separate step, run
 * later and out of band. That is what makes a mail failure survivable: the
 * message is already recorded, so the retry has something to retry, and an
 * operator can see that it happened.
 *
 * NOTHING IN THIS FILE THROWS INTO ITS CALLER. A store must not fail to record a
 * payment because an email could not be prepared. `queue` catches, logs and
 * returns null; every caller is free to ignore the result.
 */

import { db, tryDb, storeOrigin } from './env';
import { randomToken } from './crypto';
import { formatMoney } from './money';

export type MailTemplate =
  | 'order.confirmation'
  | 'order.shipped'
  | 'order.refunded'
  | 'contact.acknowledgement'
  | 'staff.contact';

export interface OutboxRow {
  id: string;
  template: string;
  to_email: string;
  to_name: string;
  subject: string;
  body_text: string;
  body_html: string;
  entity: string;
  entity_id: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
  last_error: string;
  provider_message_id: string | null;
  next_attempt_at: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * How many attempts before a message is left alone.
 *
 * Five, with the backoff below, spreads retries over about half a day. Beyond
 * that a failure is not transient — it is a bad address or a misconfigured
 * provider — and retrying it forever would bury the ones that could still work.
 */
export const MAX_ATTEMPTS = 5;

/**
 * When to try again, in minutes, indexed by the attempt just made.
 *
 * A first retry is quick, because most failures are a blip. Later ones are far
 * apart, because a provider having an outage does not want to be hammered.
 */
const BACKOFF_MINUTES = [1, 5, 30, 120, 480];

export function nextAttemptMinutes(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[index] ?? 480;
}

/** Escape for HTML. Message bodies quote customer-supplied text. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The plain-text body, and an HTML rendering of the same content.
 *
 * Both, always. A text part is what a receipt reader, a terminal client and a
 * screen reader get; sending HTML alone is a choice to make some customers read
 * raw markup. The HTML is generated from the SAME lines, so the two cannot drift
 * apart into two different messages.
 */
function render(subject: string, lines: string[], action?: { label: string; url: string }) {
  const text = [subject, '', ...lines, ...(action ? ['', `${action.label}: ${action.url}`] : []), '', '— Ozikoro Store', storeOrigin()]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.55;color:#141414;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${esc(subject)}</h1>
${lines.map((line) => (line === '' ? '<div style="height:10px"></div>' : `<p style="margin:0 0 10px">${esc(line)}</p>`)).join('\n')}
${action ? `<p style="margin:22px 0"><a href="${esc(action.url)}" style="background:#ddb02f;color:#141414;padding:11px 20px;text-decoration:none;font-weight:600">${esc(action.label)}</a></p>` : ''}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">
<p style="margin:0;font-size:12px;color:#767676">Ozikoro Store · <a href="${esc(storeOrigin())}" style="color:#767676">${esc(storeOrigin())}</a></p>
</body></html>`;

  return { text, html };
}

export interface QueuedMail {
  template: MailTemplate;
  to: string;
  toName?: string;
  subject: string;
  lines: string[];
  action?: { label: string; url: string };
  entity?: string;
  entityId?: string;
}

/**
 * Record a message the store owes.
 *
 * Returns the row, or null when it could not be written. It never throws: a
 * failure to queue an email must not roll back the thing that caused it — the
 * order is still paid, and the money is still real.
 */
export async function queue(mail: QueuedMail): Promise<OutboxRow | null> {
  if (!tryDb()) return null;
  if (!mail.to || !mail.to.includes('@')) {
    console.error('[mail] refusing to queue a message with no usable address', mail.template);
    return null;
  }

  const { text, html } = render(mail.subject, mail.lines, mail.action);

  try {
    const id = `eml_${randomToken(12)}`;
    // `ON CONFLICT DO NOTHING` against the one-per-entity unique index: a second
    // confirmation for the same order is silently dropped rather than sent twice.
    const result = await db()
      .prepare(
        `INSERT INTO email_outbox (id, template, to_email, to_name, subject, body_text, body_html, entity, entity_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT DO NOTHING`
      )
      .bind(
        id,
        mail.template,
        mail.to,
        mail.toName ?? '',
        mail.subject.slice(0, 200),
        text,
        html,
        mail.entity ?? '',
        mail.entityId ?? ''
      )
      .run();

    if (!result.meta || (result.meta['changes'] as number) === 0) {
      // Already queued for this entity. Not an error: it means the settlement
      // ran twice, which the outbox is designed to absorb.
      return null;
    }
    return await findMessage(id);
  } catch (error) {
    console.error('[mail] could not queue', mail.template, error);
    return null;
  }
}

export async function findMessage(id: string): Promise<OutboxRow | null> {
  return db().prepare('SELECT * FROM email_outbox WHERE id = ?1').bind(id).first<OutboxRow>();
}

/** Messages waiting to go, oldest first. */
export async function dueMessages(limit = 25): Promise<OutboxRow[]> {
  const result = await db()
    .prepare(
      `SELECT * FROM email_outbox
        WHERE status = 'pending' AND next_attempt_at <= datetime('now')
        ORDER BY created_at
        LIMIT ?1`
    )
    .bind(limit)
    .all<OutboxRow>();
  return result.results ?? [];
}

/** Everything about one order or record, for the admin. */
export async function messagesFor(entity: string, entityId: string): Promise<OutboxRow[]> {
  const result = await db()
    .prepare('SELECT * FROM email_outbox WHERE entity = ?1 AND entity_id = ?2 ORDER BY created_at DESC')
    .bind(entity, entityId)
    .all<OutboxRow>();
  return result.results ?? [];
}

export async function recentMessages(limit = 50): Promise<OutboxRow[]> {
  const result = await db()
    .prepare('SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT ?1')
    .bind(limit)
    .all<OutboxRow>();
  return result.results ?? [];
}

/**
 * Claim a message for sending.
 *
 * The conditional UPDATE is the guard, exactly as it is for a payment: only one
 * sender can move a row out of `pending`, so two concurrent flushes cannot both
 * deliver the same email. A message stuck in `sending` — because the isolate was
 * evicted mid-send — is reclaimed after fifteen minutes, which is why the
 * `updated_at` test is here rather than a bare status check.
 */
export async function claimForSending(id: string): Promise<OutboxRow | null> {
  const result = await db()
    .prepare(
      `UPDATE email_outbox
          SET status = 'sending', attempts = attempts + 1, updated_at = datetime('now')
        WHERE id = ?1
          AND (status = 'pending' OR (status = 'sending' AND updated_at <= datetime('now', '-15 minutes')))`
    )
    .bind(id)
    .run();

  if (!result.meta || (result.meta['changes'] as number) === 0) return null;
  return findMessage(id);
}

export async function markSent(id: string, providerMessageId: string | null): Promise<void> {
  await db()
    .prepare(
      `UPDATE email_outbox
          SET status = 'sent', sent_at = datetime('now'), last_error = '', provider_message_id = ?2, updated_at = datetime('now')
        WHERE id = ?1`
    )
    .bind(id, providerMessageId)
    .run();
}

/**
 * Record a failed attempt, and decide whether to try again.
 *
 * Past `MAX_ATTEMPTS` the message becomes `failed` and stops being picked up.
 * It is NOT deleted: an operator needs to see that a customer was never told,
 * and to be able to requeue it once the cause is fixed.
 */
export async function markFailed(id: string, reason: string, exhaustedOverride = false): Promise<void> {
  const message = await findMessage(id);
  if (!message) return;
  // `exhaustedOverride` is for a PERMANENT failure — an address the provider
  // rejected, a domain it has not verified. Retrying those on the backoff
  // schedule cannot help, and it delays the moment somebody notices that a
  // customer was never told.
  const exhausted = exhaustedOverride || message.attempts >= MAX_ATTEMPTS;
  const minutes = nextAttemptMinutes(message.attempts);
  await db()
    .prepare(
      `UPDATE email_outbox
          SET status = ?2,
              last_error = ?3,
              next_attempt_at = datetime('now', '+' || ?4 || ' minutes'),
              updated_at = datetime('now')
        WHERE id = ?1`
    )
    .bind(id, exhausted ? 'failed' : 'pending', reason.slice(0, 600), minutes)
    .run();
}

/** Put a failed or cancelled message back in the queue. */
export async function requeue(id: string): Promise<boolean> {
  const result = await db()
    .prepare(
      `UPDATE email_outbox
          SET status = 'pending', attempts = 0, last_error = '', next_attempt_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?1 AND status IN ('failed', 'cancelled')`
    )
    .bind(id)
    .run();
  return Boolean(result.meta && (result.meta['changes'] as number) > 0);
}

export interface OutboxSummary {
  pending: number;
  sending: number;
  sent: number;
  failed: number;
}

export async function summary(): Promise<OutboxSummary> {
  const result = await db()
    .prepare('SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status')
    .all<{ status: string; n: number }>();
  const out: OutboxSummary = { pending: 0, sending: 0, sent: 0, failed: 0 };
  for (const row of result.results ?? []) {
    if (row.status in out) out[row.status as keyof OutboxSummary] = Number(row.n);
  }
  return out;
}

// ---------------------------------------------------------------- templates
//
// Each one is a small function rather than a string in a switch, so the callers
// read as intent — `queueOrderConfirmation(order)` — and the wording lives in one
// place per message instead of being assembled at the call site.

export interface OrderMailFacts {
  number: string;
  email: string;
  customerName: string;
  totalMinor: number;
  currency: string;
  lines: Array<{ title: string; variantTitle: string; quantity: number; unitPriceMinor: number }>;
  shippingAddress: string[];
  reference: string;
}

/**
 * The confirmation a customer gets when their payment settles.
 *
 * It repeats the ADDRESS and the ITEMS, not just the total, because this is the
 * message people search their inbox for when a parcel is late or arrives wrong.
 * It carries the order number in the subject so it is findable without opening.
 */
export async function queueOrderConfirmation(order: OrderMailFacts): Promise<OutboxRow | null> {
  const items = order.lines.map(
    (line) =>
      `${line.quantity} × ${line.title}${line.variantTitle ? ` — ${line.variantTitle}` : ''}  ${formatMoney(
        line.unitPriceMinor * line.quantity,
        order.currency
      )}`
  );

  return queue({
    template: 'order.confirmation',
    to: order.email,
    toName: order.customerName,
    subject: `Order ${order.number} confirmed`,
    lines: [
      `Thank you${order.customerName ? `, ${order.customerName}` : ''}. We have received your payment and your order is confirmed.`,
      '',
      `Order ${order.number}`,
      `Payment reference ${order.reference}`,
      '',
      ...items,
      '',
      `Total ${formatMoney(order.totalMinor, order.currency)}`,
      '',
      'Delivering to:',
      ...order.shippingAddress,
      '',
      'We will write again when it is on its way. Reply to this message if anything looks wrong.',
    ],
    action: { label: 'View your order', url: `${storeOrigin()}/account` },
    entity: 'order',
    entityId: order.number,
  });
}

export async function queueShippedNotice(input: {
  number: string;
  email: string;
  customerName: string;
  carrier: string;
  trackingNumber: string;
  trackingUrl: string;
}): Promise<OutboxRow | null> {
  return queue({
    template: 'order.shipped',
    to: input.email,
    toName: input.customerName,
    subject: `Order ${input.number} is on its way`,
    lines: [
      `Your order ${input.number} has been dispatched.`,
      '',
      input.carrier ? `Carrier: ${input.carrier}` : '',
      input.trackingNumber ? `Tracking number: ${input.trackingNumber}` : '',
      '',
      'If a tracking link is provided below, it may take a few hours to become active.',
    ].filter((line) => line !== ''),
    ...(input.trackingUrl ? { action: { label: 'Track your parcel', url: input.trackingUrl } } : {}),
    entity: 'order',
    entityId: input.number,
  });
}

export async function queueRefundNotice(input: {
  number: string;
  email: string;
  customerName: string;
  amountMinor: number;
  currency: string;
}): Promise<OutboxRow | null> {
  return queue({
    template: 'order.refunded',
    to: input.email,
    toName: input.customerName,
    subject: `Refund issued for order ${input.number}`,
    lines: [
      `We have refunded ${formatMoney(input.amountMinor, input.currency)} for order ${input.number}.`,
      '',
      'Banks take a few working days to show it. If it has not appeared after five, reply to this message and we will chase it.',
    ],
    entity: 'order',
    entityId: `${input.number}:refunded`,
  });
}

/** The customer's own copy of what they sent us. */
export async function queueContactAcknowledgement(input: {
  name: string;
  email: string;
  topic: string;
  message: string;
  messageId: string;
}): Promise<OutboxRow | null> {
  return queue({
    template: 'contact.acknowledgement',
    to: input.email,
    toName: input.name,
    subject: 'We have your message',
    lines: [
      `Thank you${input.name ? `, ${input.name}` : ''}. Your message has reached us and a person will read it.`,
      '',
      input.topic ? `About: ${input.topic}` : '',
      '',
      'What you sent:',
      input.message.slice(0, 1200),
    ].filter((line) => line !== ''),
    entity: 'contact',
    entityId: input.messageId,
  });
}

/** The message the shop itself receives, so nothing depends on the admin screen. */
export async function queueStaffNotice(input: {
  staffEmail: string;
  name: string;
  email: string;
  topic: string;
  message: string;
  messageId: string;
}): Promise<OutboxRow | null> {
  return queue({
    template: 'staff.contact',
    to: input.staffEmail,
    subject: `Contact form: ${input.topic || 'a new message'}`,
    lines: [
      `${input.name || 'Someone'} (${input.email}) wrote to the store.`,
      '',
      input.topic ? `About: ${input.topic}` : '',
      '',
      input.message.slice(0, 4000),
    ].filter((line) => line !== ''),
    entity: 'contact',
    entityId: `${input.messageId}:staff`,
  });
}

export { esc as escapeHtml };
