import { describe, expect, it } from 'vitest';

import { COMING_SOON_PATH, isHiddenWhenClosed } from '../lib/storefront';

/**
 * Which paths a closed shop hides.
 *
 * This is an ALLOWLIST, and the allowlist is the part that can do real damage. A
 * blocklist's failure mode is a new public page nobody remembered to add; an
 * allowlist's failure mode is hiding something that had to stay reachable. Both
 * directions are tested here, because each has a specific consequence:
 *
 *   hiding the webhook      a payment taken before the shop closed cannot settle,
 *                           and a customer's money is stranded
 *   hiding the admin        the owner cannot open the shop again
 *   hiding /oidc            signing in to ozikoro.com and ozituma.com breaks
 *   not hiding the shop     the shop is not actually closed
 */
describe('what a closed storefront hides', () => {
  it('hides the storefront itself', () => {
    for (const path of [
      '/',
      '/shop',
      '/collections',
      '/products/the-ozikoro-reader',
      '/search',
      '/cart',
      '/checkout',
      '/checkout/callback',
      '/contact',
      '/privacy',
      '/terms',
    ]) {
      expect(isHiddenWhenClosed(path), `${path} must be hidden`).toBe(true);
    }
  });

  it('KEEPS SIGN-IN REACHABLE, because the whole platform signs in through it', () => {
    // `ozikoro.com` and `ozituma.com` send their users to `/account` to
    // authenticate. Hiding it with the shop would break single sign-on across the
    // platform every time the store was closed — a far worse outcome than a
    // sign-in form being visible.
    expect(isHiddenWhenClosed('/account')).toBe(false);
    expect(isHiddenWhenClosed('/order-lookup')).toBe(false);
    // It is the PAGE that stays reachable, not the shop behind it.
    expect(isHiddenWhenClosed('/account/orders')).toBe(false);
  });

  it('KEEPS THE PAYMENT WEBHOOK REACHABLE', () => {
    // A payment taken before the shop closed must still be able to settle.
    expect(isHiddenWhenClosed('/api/webhooks/paystack')).toBe(false);
  });

  it('keeps the admin reachable, or nobody could reopen the shop', () => {
    for (const path of ['/admin', '/admin/store', '/admin/orders', '/admin/products/x']) {
      expect(isHiddenWhenClosed(path), `${path} must stay reachable`).toBe(false);
    }
  });

  it('keeps the identity provider reachable', () => {
    for (const path of [
      '/oidc/authorize',
      '/oidc/token',
      '/oidc/callback',
      '/oidc/jwks.json',
      '/.well-known/openid-configuration',
    ]) {
      expect(isHiddenWhenClosed(path), `${path} must stay reachable`).toBe(false);
    }
  });

  it('keeps the coming-soon page reachable, or it would redirect to itself', () => {
    expect(isHiddenWhenClosed(COMING_SOON_PATH)).toBe(false);
  });

  it('does not mistake a similar name for the real one', () => {
    // `/administrate` is not `/admin`. Prefix matching on whole segments is what
    // prevents an allowlisted name from opening a door somewhere else.
    expect(isHiddenWhenClosed('/administrate')).toBe(true);
    expect(isHiddenWhenClosed('/apix')).toBe(true);
    expect(isHiddenWhenClosed('/oidcish')).toBe(true);
  });

  it('ignores a query string and a trailing slash', () => {
    expect(isHiddenWhenClosed('/shop?page=2')).toBe(true);
    expect(isHiddenWhenClosed('/admin/store?x=1')).toBe(false);
  });

  it('hides anything that is not a rooted path', () => {
    expect(isHiddenWhenClosed('shop')).toBe(true);
    expect(isHiddenWhenClosed('')).toBe(true);
  });
});
