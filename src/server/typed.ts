/**
 * The input readers every handler uses, and one note about the declaration form.
 *
 * ON DECLARING A SERVER FUNCTION
 *
 * Use the library's own call, and pass the RESPONSE TYPE FIRST:
 *
 *   export const getShop = createServerFn<ShopData>({ method: 'GET' }).handler(…)
 *
 * `createServerFn`'s generic order is `<TResponse, TMethod, TStrict>`: the
 * response comes FIRST. Passing the method and strictness first — which is what
 * an earlier version of this file did — leaves the response at its `unknown`
 * default, and every call site then needs a cast. That mistake cost a long
 * afternoon; it is written down here so it cannot be repeated.
 *
 * Do not wrap it. The Start compiler interns a server function by finding a
 * literal `createServerFn(...)` call, so a wrapper hides the call, the handler
 * body stays in the client bundle, and the request-API import it reaches is
 * reported as "denied in client environment" from a file no client code
 * imports. Keep the call literal.
 */

/**
 * Read a validated field with an explicit fallback.
 *
 * A validator that returns an object of optional fields produces `T | undefined`
 * under `exactOptionalPropertyTypes`, and every use would otherwise need its own
 * `??`. These two do the narrowing once, by type, so a string field cannot be
 * passed where a string is required.
 */
export function readString<T extends Record<string, unknown>>(
  data: Partial<T>,
  key: keyof T,
  fallback = ''
): string {
  const value = data[key];
  return typeof value === 'string' ? value : fallback;
}

export function readNumber<T extends Record<string, unknown>>(
  data: Partial<T>,
  key: keyof T,
  fallback = 0
): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
