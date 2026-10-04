/**
 * GET /.well-known/openid-configuration — how a client finds everything else.
 *
 * The `issuer` in this document must be byte-identical to the `iss` claim in
 * every ID token. A client compares them exactly, and the most common way to
 * break a working integration is a stray trailing slash in one of the two. Both
 * come from `issuer()` in `src/lib/oidc-protocol.ts`, so they cannot differ.
 */

import { discoveryDocument } from '../../src/lib/oidc-protocol';

export default {
  fetch(): Response {
    return new Response(JSON.stringify(discoveryDocument(), null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  },
};
