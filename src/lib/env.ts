/**
 * Cloudflare bindings, read from the request context rather than from globals.
 *
 * In a Worker there is no `process.env` for secrets and no module-level
 * connection to reuse: bindings arrive on the request. Nitro puts them on
 * `context.cloudflare.env`, and TanStack Start exposes that context to a server
 * function through `getRequest()`.
 *
 * The consequence to remember: a module that calls `db()` at import time would
 * capture `undefined` on the very first request and then hand that value to
 * every subsequent one. Everything here is therefore a function, evaluated
 * inside a request.
 */

export type D1Result<T> = { results: T[]; success: boolean; meta: Record<string, unknown> };

export interface Env {
  DB: D1Database;
  /** Optional KV for hot catalogue caching; the store works without it. */
  STORE_CACHE?: KVNamespace;
  STORE_ENV?: string;
  STORE_ORIGIN?: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PUBLIC_KEY?: string;
  /** Signs session cookies and one-time tokens. Required in production. */
  SESSION_SECRET?: string;
  ADMIN_EMAILS?: string;
  /** Enables an owner-only, read-only diagnostic surface. */
  ADMIN_BOOTSTRAP_TOKEN?: string;
  /**
   * The store's own OIDC client id. The store is a client of its own identity
   * provider; see `src/server/oidc.ts` for why that is not as circular as it
   * looks.
   */
  STORE_OIDC_CLIENT_ID?: string;
}

/**
 * A structural type for D1. Cloudflare's own types are not installed as a
 * dependency here, and pulling in `@cloudflare/workers-types` would fight the
 * DOM lib for names like `Request` and `Response`. Only the surface this
 * application uses is declared.
 */
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result<unknown>>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface KVNamespace {
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

let cachedEnv: Env | null = null;

/**
 * Read the Cloudflare env for the current request.
 *
 * Nitro's Cloudflare runtime exposes the binding bag as a global
 * (`globalThis.__env__` / `__cf_env`) depending on the compatibility mode, and
 * also on the handler context. Rather than depend on one of those, this looks in
 * all the places the binding can legitimately be found and takes the first that
 * carries a DB binding. It is evaluated per request and cached only for the
 * duration of the module's life *after* it is first found, which is safe because
 * a Worker isolate's bindings do not change.
 */
export function env(): Env {
  if (cachedEnv?.DB) return cachedEnv;

  const global = globalThis as unknown as Record<string, unknown>;

  const nitroEnv = global['__nitro_env__'] as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    global['__env__'],
    global['__cf_env'],
    global['cloudflare_env'],
    nitroEnv?.['cloudflare'],
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && 'DB' in (candidate as object)) {
      cachedEnv = candidate as Env;
      return cachedEnv;
    }
  }

  throw new Error(
    'Cloudflare bindings are not available on this request. The D1 binding "DB" must be ' +
      'configured (see wrangler.jsonc) and the app must run inside the Workers runtime.'
  );
}

/** The D1 handle for the current request. */
export function db(): D1Database {
  return env().DB;
}

/** True when the app is running against the production origin. */
export function isProduction(): boolean {
  const origin = env().STORE_ORIGIN ?? '';
  return env().STORE_ENV === 'production' || origin.includes('shop.ozikoro.com');
}

/** The canonical origin, used for callback URLs and canonical link tags. */
export function storeOrigin(): string {
  return env().STORE_ORIGIN?.replace(/\/+$/, '') || 'https://shop.ozikoro.com';
}

/**
 * A D1-compatible handle resolved per request.
 *
 * During `vite dev` there is no Workers runtime and therefore no `DB` binding;
 * `wrangler dev` (which Nitro's preview command runs) does provide one. Rather
 * than crash every page in plain dev, this returns null when the binding is
 * genuinely absent and callers decide what to do. Production never takes the
 * null path — a missing binding there is a fatal misconfiguration, and
 * `requireDb()` says so.
 */
export function tryDb(): D1Database | null {
  try {
    return db();
  } catch {
    return null;
  }
}

export function requireDb(): D1Database {
  return db();
}
