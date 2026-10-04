/**
 * The actor behind a request: who is asking, and the request facts a rate limit
 * needs.
 *
 * WHY THIS FILE EXISTS
 *
 * The Start compiler loads every module a client route imports into the client
 * environment, so it can strip the `createServerFn` handler bodies out and leave
 * an RPC stub. `server/store.ts` is therefore in the client graph, and anything
 * it statically imports — or lazily imports from a function that SURVIVES that
 * stripping — is analysed there too. `@tanstack/react-start/server` is denied in
 * that environment, and rightly so: `getCookie()` in a browser bundle is either
 * a lie or a crash.
 *
 * So the request-scoped work lives here, and NOTHING client-side imports this
 * file. Every caller reaches it with `await import('./actor')` from inside a
 * handler body — code the compiler removes from the client chunk, taking the
 * import edge with it.
 *
 * Everything here must be called from inside a handler. Calling `currentActor()`
 * at module scope would run it once, on whichever request happened to be first.
 */

import { SESSION_COOKIE, actorFromToken, requireCapability, type Actor } from '../lib/auth';
import { sha256 } from '../lib/crypto';
import type { Capability } from '../lib/roles';
import { readCookie, clientIp } from './request';

/** Who is asking, or null when there is no valid session. */
export async function currentActor(): Promise<Actor | null> {
  const token = readCookie(SESSION_COOKIE);
  return actorFromToken(token ?? null);
}

/**
 * A stable, non-reversible key for the caller's address.
 *
 * Hashed rather than stored raw: a rate-limit key needs to be stable, not
 * personal.
 */
export function ipHash(): string {
  return sha256(clientIp()).slice(0, 32);
}

/** The actor, or a thrown AuthenticationError / AuthorizationError. */
export async function requireStaff(capability: Capability): Promise<Actor> {
  return requireCapability(await currentActor(), capability);
}
