/**
 * POST /api/webhooks/paystack
 *
 * Another framework's route file. See `src/server/paystack-webhook.ts` for the
 * handler and the reasoning behind its three checks.
 */

import { handlePaystackWebhook } from '@/server/paystack-webhook';

export default {
  fetch: (request: Request) => handlePaystackWebhook(request),
};
