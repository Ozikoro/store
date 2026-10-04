/**
 * The type of a declared server function, as the client calls it.
 *
 * THE PROBLEM THESE SOLVE
 *
 * `createServerFn`'s generic order is `<TMethod, TStrict, TResponse, …>` — the
 * RESPONSE IS THIRD, and its default is `unknown`. Two consequences:
 *
 *   - `createServerFn<MyResponse>(…)` puts a response type where the method
 *     belongs and fails the `extends Method` constraint;
 *   - `createServerFn<'GET', true, MyResponse>(…)` type-checks the handler but
 *     still resolves the chain to `any` here, because the serialisability
 *     validator needs a `Register` generic that is not populated in this setup.
 *     `any` then swallows every later assertion, which is why the response type
 *     kept disappearing at the call site.
 *
 * THE SHAPE THAT WORKS, and it is the one used everywhere in `src/server/`:
 *
 *   export const getShop: DeclaredServerFnNoInput<ShopData> =
 *     createServerFn({ method: 'GET' }).handler(
 *       async (): Promise<ShopData> => { … }
 *     ) as unknown as DeclaredServerFnNoInput<ShopData>;
 *
 *   - the literal `createServerFn({ method })` call is what the compiler needs
 *     to intern the function and strip the handler from the client bundle;
 *   - the handler's `: Promise<ShopData>` return annotation is what makes the
 *     BODY checked against the contract — the cast cannot hide a wrong shape;
 *   - the declared type on the constant is what makes every CALL SITE see it.
 *
 * `DeclaredServerFn` is for a function with validated input;
 * `DeclaredServerFnNoInput` for one without.
 */

/** A declared server function that takes validated input. */
export interface DeclaredServerFn<TResponse, TInput = unknown> {
  (options: { data: TInput }): Promise<TResponse>;
}

/** A declared server function whose validator has no required input. */
export interface DeclaredServerFnNoInput<TResponse> {
  (options?: { data?: undefined }): Promise<TResponse>;
}
