/**
 * Is the storefront open to the public?
 *
 * WHY A SETTING AND NOT A BUILD FLAG
 *
 * Opening and closing a shop is an operational decision — a launch date, a stock
 * problem, a mistake found at the wrong moment. A build flag makes it a code
 * change and a deploy, which in practice means it is never done when it is
 * needed. The switch lives in the database so whoever is responsible for the shop
 * can throw it.
 *
 * THE DEFAULT IS CLOSED, AND THAT IS DELIBERATE.
 *
 * Everywhere else in this codebase a missing setting falls back to the readable
 * choice — a missing description still produces a page. Here the fallback is the
 * CLOSED one: if the settings table cannot be read, or the row was never written,
 * strangers must not be shown a shop that somebody was in the middle of
 * preparing. Failing closed is the only safe direction for a visibility switch,
 * and `store.open` is written to '1' explicitly by the migration so a working
 * deployment is unaffected.
 */

import { db } from './env';
import { recordAudit, type AuditActor } from './audit';

/** The setting key. `kind: 'none'` — stored and read, never emitted as a tag. */
export const STORE_OPEN_KEY = 'store.open';

/** The page a closed storefront sends everyone to. */
export const COMING_SOON_PATH = '/coming-soon';

/**
 * Where the storefront is reachable while it is closed.
 *
 * An allowlist rather than a blocklist, because the failure mode of a blocklist
 * is a new public route nobody remembered to add. Everything NOT listed here is
 * hidden from the public when the shop is closed.
 *
 * The exclusions exist because these are not the storefront:
 *
 *   /admin*      staff must be able to open the shop, and to work while it is
 *                shut. Locking the door the owner uses would be absurd.
 *   /api/*       the Paystack webhook. A payment taken BEFORE the shop closed
 *                must still be able to settle; blocking this would strand a
 *                customer's money.
 *   /oidc/*      the identity provider, which ozikoro.com and ozituma.com call.
 *                Those platforms are not the storefront and must keep working.
 *   /.well-known the discovery document the same clients read.
 *   /coming-soon the page itself, or it would redirect to itself.
 *   /account     SIGN-IN. Not a storefront page — it is how the identity provider
 *                authenticates people, and `ozikoro.com` and `ozituma.com` send
 *                their users here to sign in. Hiding it would break single
 *                sign-on across the whole platform every time the shop was
 *                closed, which is a far worse outcome than a sign-in form being
 *                visible. The storefront routes below it stay hidden.
 *   /order-lookup the same page family: the way a customer asks about an order
 *                they already placed. It reveals nothing without the order number
 *                and the email on it, both of which the asker must supply.
 *
 * `robots.txt` and `sitemap.xml` are static routes served by the worker, not by
 * the router, so they do not pass through here.
 */
const ALWAYS_REACHABLE = [
  COMING_SOON_PATH,
  '/admin',
  '/api',
  '/oidc',
  '/.well-known',
  // Identity, not storefront. See the note above for why this cannot be hidden
  // along with the shop.
  '/account',
  '/order-lookup',
];

/**
 * Should this path be hidden while the shop is closed?
 *
 * Matched on whole segments, so `/administrate` is not treated as `/admin`.
 */
export function isHiddenWhenClosed(pathname: string): boolean {
  const path = pathname.split('?')[0] ?? '/';
  if (!path.startsWith('/')) return true;

  return !ALWAYS_REACHABLE.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

/**
 * The switch, as a boolean.
 *
 * Fails CLOSED. A thrown read, a missing row or an unreadable value all mean
 * "closed", because the alternative is exposing a half-prepared shop the moment
 * one query fails.
 *
 * Written as a truthiness check on the string `'1'` rather than on any non-empty
 * value: `'0'`, `'false'` and `''` must all read as closed, and a bare
 * `Boolean(value)` would treat `'0'` as open — which is precisely the mistake a
 * switch like this gets wrong.
 */
export async function storefrontIsOpen(): Promise<boolean> {
  try {
    const row = await db()
      .prepare('SELECT value FROM settings WHERE key = ?1')
      .bind(STORE_OPEN_KEY)
      .first<{ value: string }>();
    return String(row?.value ?? '').trim() === '1';
  } catch (error) {
    console.error('[storefront] could not read whether the shop is open; treating it as CLOSED', error);
    return false;
  }
}

/**
 * Open or close the shop, and record who did it and when.
 *
 * AUDITED, because it is the switch that decides whether strangers can spend
 * money. "Why did the shop come back on at 3am" is a question that needs an
 * answer, and the audit log is where this codebase keeps those answers.
 *
 * Written as an UPDATE against the existing row rather than an upsert. The row is
 * created by the migration, and a switch that can silently create itself is a
 * switch that can be created by a typo — `saveSettings` refuses unknown keys for
 * the same reason.
 */
export async function setStorefrontOpen(open: boolean, actor: AuditActor | null): Promise<void> {
  const value = open ? '1' : '0';

  const result = await db()
    .prepare(`UPDATE settings SET value = ?1, updated_at = datetime('now') WHERE key = ?2`)
    .bind(value, STORE_OPEN_KEY)
    .run();

  // Zero rows means the migration never ran. Fail loudly rather than reporting a
  // success that changed nothing, which would leave somebody believing the shop
  // was open when it was not.
  const changed = Number((result.meta as { changes?: number } | undefined)?.changes ?? 0);
  if (changed === 0) {
    throw new Error(
      'The storefront switch is missing from the settings table — apply migration 0007_storefront_visibility.sql.'
    );
  }

  await recordAudit({
    actor,
    action: open ? 'storefront.opened' : 'storefront.closed',
    entity: 'setting',
    entityId: STORE_OPEN_KEY,
    after: {
      open,
      note: open
        ? 'The storefront is now visible to the public.'
        : 'The storefront is now hidden behind the coming-soon page.',
    },
  });
}
