/**
 * Request-scoped helpers: cookies, headers, client IP.
 *
 * This module exists because of a build rule, and the rule is worth stating.
 *
 * `@tanstack/react-start/server` exports functions that only work inside a
 * request. The Start compiler refuses to let a module that the client graph can
 * reach import them at the top level, which is correct — `getCookie()` in a
 * browser bundle is either a lie or a crash. But a server-function module IS in
 * the client graph (the compiler loads it there to strip the handler bodies out
 * and leave an RPC stub), so a top-level import of the helpers from such a
 * module fails the build.
 *
 * The fix is to keep the helpers in their own module and reach them with a
 * dynamic `import()` INSIDE a handler. A handler body is removed from the client
 * bundle, so the dynamic import never runs in a browser and the compiler is
 * satisfied. The cost is one promise per request, which is nothing next to a D1
 * round trip.
 *
 * Every function here must be called from within a handler. Calling one at
 * module scope would run it once, on whichever request happened to be first.
 */

import {
  deleteCookie as rawDeleteCookie,
  getCookie as rawGetCookie,
  getRequestHeader,
  getRequestIP,
  setCookie as rawSetCookie,
} from '@tanstack/react-start/server';

export interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  secure?: boolean;
  path?: string;
  maxAge?: number;
  expires?: Date;
}

export function readCookie(name: string): string | undefined {
  return rawGetCookie(name);
}

export function writeCookie(name: string, value: string, options?: CookieOptions): void {
  rawSetCookie(name, value, options);
}

export function clearCookie(name: string, options?: CookieOptions): void {
  rawDeleteCookie(name, options);
}

export function header(name: string): string | undefined {
  return getRequestHeader(name);
}

export function userAgent(): string {
  return getRequestHeader('user-agent') ?? '';
}

/** The caller's IP as the proxy reports it, or 'unknown'. */
export function clientIp(): string {
  return getRequestIP({ xForwardedFor: true }) ?? 'unknown';
}
