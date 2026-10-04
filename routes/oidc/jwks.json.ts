/**
 * GET /oidc/jwks.json — the public keys clients verify ID tokens with.
 *
 * Every active key is published, not only the newest, so a rotation is not an
 * outage: a token signed a minute ago still verifies against the key that signed
 * it. Clients cache this, which is why the cache header is generous but not
 * unlimited — the window has to be short enough that a rotation takes effect
 * within a token lifetime.
 */

import { publishedKeys } from '../../src/lib/oidc-keys';

export default {
  async fetch(): Promise<Response> {
    const keys = await publishedKeys();
    return new Response(JSON.stringify({ keys }), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // Public and non-secret, so it may be cached at the edge; an hour is well
        // inside the ten-minute ID token lifetime plus the grace a rotation gets.
        'cache-control': 'public, max-age=3600',
      },
    });
  },
};
