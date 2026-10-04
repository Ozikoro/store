/**
 * POST /api/webhooks/paystack
 *
 * Paystack posts here when a transaction settles — successfully or otherwise.
 * This is the reliable path: the customer may close the tab, lose signal, or
 * wander off on the checkout page and never come back, so the redirect alone
 * would lose orders. The webhook arrives because Paystack's servers decided to
 * send it.
 *
 * THREE THINGS ARE CHECKED, AND ALL THREE MATTER
 *
 *   1. The signature. Paystack signs the raw body with HMAC-SHA512 using the
 *      secret key and sends `x-paystack-signature`. Without this check the
 *      endpoint is an open invitation: anyone who learns the URL could POST
 *      "order OZK-10001 is paid" and we would believe it. The signature is over
 *      the exact bytes, so the body is read as TEXT and verified BEFORE it is
 *      parsed — a parse-then-reserialise round trip changes whitespace and key
 *      order and the signature would never match again.
 *
 *   2. Replay. The SHA-256 of the raw body is recorded in `webhook_events` with
 *      a UNIQUE constraint, so the same delivery arriving twice is recognised
 *      as the same event and does no work the second time. Only the event
 *      TYPE + reference fix the order; the delivery is the unit of dedup.
 *
 *   3. The gateway itself. A valid signature proves Paystack sent the event. It
 *      does not prove the money settled, so the transaction is verified directly
 *      with the API — the same call the callback page makes. A signed event and
 *      an independent confirmation agreeing is what makes the record
 *      trustworthy.
 *
 * WHAT IT RETURNS
 *
 * 200 for anything Paystack signed, including references we do not recognise.
 * Paystack retries non-2xx responses, and retrying will never make an unknown
 * reference become known, so 200 is the honest answer to "this is nothing to do
 * with me". 401 is reserved for a bad signature, which is the one case where the
 * caller is not Paystack at all. 5xx is reserved for OUR failures — a database
 * that is unreachable right now — because a retry is exactly what we want then.
 */

import { db, env } from '../lib/env';
import { sha256, randomToken } from '../lib/crypto';
import { verifyWebhookSignature } from '../lib/paystack';
import { confirmOrderPayment } from '../lib/checkout';
import { findPaymentByReference, findPaymentByProviderReference, markPaymentFailed } from '../lib/orders';

export const WEBHOOK_PATH = '/api/webhooks/paystack';

interface PaystackEvent {
  event?: string;
  data?: {
    reference?: string;
    id?: number;
    status?: string;
    amount?: number;
    currency?: string;
    gateway_response?: string;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Record the delivery. Returns false when this exact body was already seen. */
async function claimEvent(input: {
  eventType: string;
  reference: string;
  bodyHash: string;
}): Promise<boolean> {
  try {
    const result = await db()
      .prepare(
        `INSERT INTO webhook_events (id, provider, event_type, reference, body_hash)
         VALUES (?1, 'paystack', ?2, ?3, ?4)
         ON CONFLICT(provider, body_hash) DO NOTHING`
      )
      .bind(`whe_${randomToken(12)}`, input.eventType, input.reference, input.bodyHash)
      .run();
    return (result.meta?.['changes'] as number) > 0;
  } catch (error) {
    // If the dedup table itself is unreachable, do not silently process: a
    // replayed event would then be applied twice. Fail and let Paystack retry.
    console.error('[paystack webhook] could not record the event', error);
    throw error;
  }
}

async function completeEvent(bodyHash: string, result: string): Promise<void> {
  await db()
    .prepare(
      `UPDATE webhook_events SET processed_at = datetime('now'), result = ?2 WHERE provider = 'paystack' AND body_hash = ?1`
    )
    .bind(bodyHash, result.slice(0, 500))
    .run();
}

export async function handlePaystackWebhook(request: Request): Promise<Response> {
  // The signature must be computed over the bytes as received, so the text is
  // read once, here, before anything else touches the body.
  const rawBody = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  if (!verifyWebhookSignature(rawBody, signature)) {
    return json({ error: 'Invalid signature' }, 401);
  }

  let event: PaystackEvent;
  try {
    event = JSON.parse(rawBody) as PaystackEvent;
  } catch {
    // Signed but unparseable: a Paystack problem, not ours, and retrying the
    // same bytes will not help. Acknowledge so it stops being retried.
    return json({ received: true, handled: false, reason: 'unparseable body' });
  }

  const eventType = typeof event.event === 'string' ? event.event : 'unknown';
  const reference = typeof event.data?.reference === 'string' ? event.data.reference : '';
  const bodyHash = sha256(rawBody);

  let fresh: boolean;
  try {
    fresh = await claimEvent({ eventType, reference, bodyHash });
  } catch {
    return json({ error: 'Could not record the event' }, 500);
  }

  if (!fresh) {
    return json({ received: true, handled: false, reason: 'duplicate delivery' });
  }

  if (!reference) {
    await completeEvent(bodyHash, 'no reference');
    return json({ received: true, handled: false, reason: 'no reference' });
  }

  try {
    if (eventType === 'charge.success') {
      const confirmation = await confirmOrderPayment(reference);
      await completeEvent(
        bodyHash,
        confirmation.ok ? `settled ${confirmation.order.number}` : `not settled: ${confirmation.error}`
      );
      return json({ received: true, handled: confirmation.ok, reference });
    }

    if (eventType === 'charge.failed' || eventType === 'transfer.failed') {
      // A failed charge never creates a paid order. The order stays pending and
      // the customer can try again; the stock it reserved is still theirs.
      const known =
        (await findPaymentByReference(reference)) ??
        (event.data?.id !== undefined ? await findPaymentByProviderReference(String(event.data.id)) : null);
      if (known) {
        await markPaymentFailed(reference, event.data?.gateway_response ?? 'Paystack reports the charge failed', event);
      }
      await completeEvent(bodyHash, 'marked failed');
      return json({ received: true, handled: Boolean(known) });
    }

    if (eventType === 'refund.processed' || eventType === 'refund.failed') {
      // Refund state is owned by the refunds table, which records the outcome of
      // an API call we made. The webhook is informational here; acknowledge it so
      // it is not retried, and leave the row as the source of truth.
      await completeEvent(bodyHash, `acknowledged ${eventType}`);
      return json({ received: true, handled: false, reason: `ignored ${eventType}` });
    }

    await completeEvent(bodyHash, `ignored ${eventType}`);
    return json({ received: true, handled: false, reason: `ignored ${eventType}` });
  } catch (error) {
    /*
     * A failure here is OUR failure and the payment is real, so the one thing we
     * must not do is answer 200: Paystack retries a 5xx, and a retry is exactly
     * what we want once the database is reachable again. The reference is logged
     * so an order can be reconciled by hand in the meantime.
     */
    console.error(`[paystack webhook] ${eventType} for ${reference} failed`, error);
    await completeEvent(bodyHash, `error: ${error instanceof Error ? error.message : 'unknown'}`).catch(() => {});
    return json({ error: 'Could not record the event' }, 500);
  }
}

/** True when this path is the webhook. Kept beside the handler so they agree. */
export function isWebhookRequest(url: string): boolean {
  try {
    return new URL(url).pathname === WEBHOOK_PATH;
  } catch {
    return false;
  }
}

/** Exposed for the health check, so "is Paystack wired up" has an answer. */
export function paystackWebhookConfigured(): boolean {
  return Boolean(env().PAYSTACK_SECRET_KEY);
}
