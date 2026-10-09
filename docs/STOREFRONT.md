# Closing the shop, and opening it again

The storefront has a visibility switch. It lives in the database, not in the
build, because closing a shop is an operational decision — a launch date, a stock
problem, a mistake spotted at the wrong moment — and a build flag turns that into
a code change and a deploy, which in practice means it does not get done when it
matters.

## Using it

**Admin → Storefront.** A checkbox and a save button. The change takes effect on
the next request; nothing is cached.

The switch is audited as `storefront.opened` / `storefront.closed`, with the
actor, so the log answers "who closed the shop, and when".

Held by `storefront:publish`: **store admins and super admins**. Deliberately not
content managers — closing a shop is not a content edit.

## What closing it does

A visitor who is not staff sees a single page at `/coming-soon`: the Ozikoro mark,
a short statement that the shop is being prepared, a link to `ozikoro.com`, and
the contact address. It carries `noindex, follow` and **no store shell** — no
cart, no search box, no account link. A closed shop should not advertise doors.

Every storefront route redirects there: `/`, `/shop`, `/collections`,
`/products/*`, `/cart`, `/checkout`, `/account/*` history, `/contact`, `/search`,
and so on. The redirect is a real `307`, so a visitor arriving from a stale link
lands somewhere they can understand.

## What closing it does NOT do

Each of these would be a real incident, so each is tested by
`scripts/e2e-storefront.mjs`:

| Kept working | Why |
|---|---|
| `/api/webhooks/paystack` | A payment taken **before** the shop closed must still be able to settle. Hiding this would strand a customer's money. |
| `/admin*` | The owner has to be able to reopen it, and to keep working while it is shut. |
| `/oidc/*`, `/.well-known/openid-configuration` | `ozikoro.com` and `ozituma.com` authenticate through this store. Closing the shop must not break single sign-on across the platform. |
| `/account`, `/order-lookup` | **Sign-in.** Not a storefront surface — it is how the identity provider authenticates people. Hiding it broke SSO the first time this was built; the OIDC suite went from 29/29 to 9/12 within minutes. |
| Staff browsing | A staff session sees the whole shop while it is closed, so the people preparing it can look at it. A closed shop is a closed door, not a blindfold for the people inside. |

**A signed-in customer is still turned away.** Being signed in is not being staff.

## The default is CLOSED

`storefrontIsOpen()` treats a missing row, an unreadable value, or a failed query
as **closed**. It also requires the exact string `'1'`, so `'0'`, `'false'` and
`''` all read as closed — a bare truthiness check would treat `'0'` as open, which
is precisely the mistake a switch like this gets made of.

The migration writes `'1'` explicitly, so an existing deployment stays open
through the change, and **re-running migrations never reopens a shop somebody
closed on purpose**: the upsert deliberately does not touch `value`.

## Running the tests while the shop is closed

Suites that drive the storefront cannot run behind a coming-soon page — the
product page redirects and the add-to-cart button is not there. Rather than fail
in a way that looks like a broken store, they stop and say so:

```
SKIPPED: https://shop.ozikoro.com is closed to the public, so this suite cannot run.
         Open it with:  Admin -> Storefront  (or set store.open = 1)
         Exit code 3 means SKIPPED, not passed and not failed.
```

**Exit codes are distinct on purpose:** `0` passed, `1` failed, `2` misconfigured,
`3` SKIPPED. "Could not run" and "ran and failed" must never be collapsed into
one another — that is how a suite that never ran gets mistaken for a green one.
