/**
 * Paystack.
 *
 * The REDIRECT flow, not the inline widget. Two consequences, both deliberate:
 * the secret key never reaches the browser (there is no public key in the page
 * at all), and the amount is fixed on the server before the customer ever sees a
 * checkout page, so it cannot be edited in flight.
 *
 * Nothing that arrives from the browser is believed. A redirect back from a
 * payment page proves nothing — anybody can type that URL — so the callback and
 * the webhook both ask Paystack directly what happened, and both then call the
 * same idempotent settlement function.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';

const API = 'https://api.paystack.co';

export function paystackSecret(): string | null {
  const key = env().PAYSTACK_SECRET_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export function paystackConfigured(): boolean {
  return paystackSecret() !== null;
}

export interface InitializeResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface PaystackFailure {
  ok: false;
  message: string;
}

export type PaystackResult<T> = (T & { ok: true }) | PaystackFailure;

/**
 * Start a transaction and return the URL to send the customer to.
 *
 * `amountMinor` is in kobo, which is exactly what the order's `total_minor`
 * holds, so no conversion happens anywhere on this path.
 */
export async function initializeTransaction(input: {
  email: string;
  amountMinor: number;
  currency: string;
  reference: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}): Promise<PaystackResult<InitializeResult>> {
  const key = paystackSecret();
  if (!key) return { ok: false, message: 'Card payment is not configured on this store yet.' };

  let response: Response;
  try {
    response = await fetch(`${API}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email,
        amount: input.amountMinor,
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      }),
      // A customer looking at a spinner is worse than an honest failure.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the payment provider: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | {
        status?: boolean;
        message?: string;
        data?: { authorization_url?: string; access_code?: string; reference?: string };
      }
    | null;

  if (!response.ok || !body?.status || !body.data?.authorization_url) {
    // Paystack never echoes the key, so its message is safe to surface.
    return { ok: false, message: body?.message ?? `Payment provider returned HTTP ${response.status}` };
  }

  return {
    ok: true,
    authorizationUrl: body.data.authorization_url,
    accessCode: body.data.access_code ?? '',
    reference: body.data.reference ?? input.reference,
  };
}

export interface VerifiedTransaction {
  paid: boolean;
  status: string;
  amountMinor: number;
  currency: string;
  email: string | null;
  reference: string;
  providerId: string | null;
  channel: string | null;
  gatewayResponse: string | null;
  paidAt: string | null;
  payload: unknown;
}

/**
 * Ask Paystack what actually happened to a reference.
 *
 * This — not the redirect, not the webhook body — is the authority on whether a
 * payment happened. It is called from both the callback and the webhook.
 */
export async function verifyTransaction(reference: string): Promise<PaystackResult<VerifiedTransaction>> {
  const key = paystackSecret();
  if (!key) return { ok: false, message: 'Card payment is not configured on this store yet.' };

  let response: Response;
  try {
    response = await fetch(`${API}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the payment provider: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | {
        status?: boolean;
        message?: string;
        data?: {
          status?: string;
          amount?: number;
          currency?: string;
          reference?: string;
          id?: number;
          channel?: string;
          gateway_response?: string;
          paid_at?: string | null;
          customer?: { email?: string };
        };
      }
    | null;

  if (!response.ok || !body?.status || !body.data) {
    return { ok: false, message: body?.message ?? `Payment provider returned HTTP ${response.status}` };
  }

  const data = body.data;
  return {
    ok: true,
    paid: data.status === 'success',
    status: String(data.status ?? 'unknown'),
    amountMinor: Number(data.amount ?? 0),
    currency: String(data.currency ?? 'NGN'),
    email: data.customer?.email ?? null,
    reference: String(data.reference ?? reference),
    providerId: data.id === undefined ? null : String(data.id),
    channel: data.channel ?? null,
    gatewayResponse: data.gateway_response ?? null,
    paidAt: data.paid_at ?? null,
    payload: body,
  };
}

/**
 * Verify a webhook really came from Paystack.
 *
 * Two details that are easy to get wrong and fatal if you do:
 *   - the signature is over the EXACT bytes received, so the body must be read
 *     as text and hashed before it is parsed. Parsing and re-serialising changes
 *     whitespace and key order and the signature will never match again.
 *   - the comparison is constant-time. `===` leaks, byte by byte, how much of a
 *     guessed signature was right.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const key = paystackSecret();
  if (!key || !signature) return false;

  const expected = createHmac('sha512', key).update(rawBody, 'utf8').digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim().toLowerCase(), 'utf8');
  // timingSafeEqual throws on a length mismatch, and that throw is itself a
  // signal, so compare lengths first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Refund a settled transaction, in whole or in part. */
export async function refundTransaction(input: {
  providerReference: string;
  amountMinor: number;
}): Promise<PaystackResult<{ status: string; providerReference: string | null }>> {
  const key = paystackSecret();
  if (!key) return { ok: false, message: 'Card payment is not configured on this store yet.' };

  let response: Response;
  try {
    response = await fetch(`${API}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transaction: input.providerReference,
        amount: input.amountMinor,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach the payment provider: ${error instanceof Error ? error.message : 'unknown error'}`,
    };
  }

  const body = (await response.json().catch(() => null)) as
    | { status?: boolean; message?: string; data?: { status?: string; id?: number } }
    | null;

  if (!response.ok || !body?.status) {
    return { ok: false, message: body?.message ?? `Payment provider returned HTTP ${response.status}` };
  }

  return {
    ok: true,
    status: String(body.data?.status ?? 'processing'),
    providerReference: body.data?.id === undefined ? input.providerReference : String(body.data.id),
  };
}
