# Outbound email

The store writes down every message it owes a customer, then delivers it
separately. Right now **it cannot deliver any of them**, because no provider is
configured — and that is worth reading twice, because the store has been silent.

## The state today

`email_outbox` holds the queue. `email_outbox` is **empty**, which means nothing
has needed to be sent yet. Both facts are visible at **Admin → Outbox**, which
says plainly when no provider is configured.

## What is already wired

Four things queue a message:

| When | Template | To |
|---|---|---|
| A payment settles | `order.confirmation` | the customer |
| A parcel is dispatched | `order.shipped` | the customer |
| A refund settles | `order.refunded` | the customer |
| The contact form is submitted | `contact.acknowledgement` **and** `staff.contact` | the customer, and the shop |

The contact form's second message is the one that matters operationally: without
it, a stranger's message lands in a table nobody opens. The contact form is the
only way someone outside the business can reach it.

**Nothing queues a password reset**, because there is no "forgot password" flow.
A signed-in customer can change their password; one who has forgotten it has to
ask. That is a real gap, and it is a decision to make rather than a bug — a reset
flow is an account-takeover surface and deserves doing deliberately.

## Turning delivery on

One secret, and delivery starts:

```bash
printf '%s' "$RESEND_API_KEY" | npx wrangler secret put RESEND_API_KEY --name ozikoro-store
```

Optional, with defaults:

| Variable | Default | Notes |
|---|---|---|
| `MAIL_FROM` | `Ozikoro Store <store@ozikoro.com>` | **Must be a domain Resend has verified**, or every send fails with a 4xx. |
| `MAIL_REPLY_TO` | `hello@ozikoro.com` | Where a reply goes. |
| `MAIL_CAPTURE` | unset | Set to `1` to record what would be sent **without sending it**. It beats a real key, so a test can never email a real person. |

Until then, **nothing is lost**. Messages queue, and they are visible.

## Draining the queue

Delivery happens in two places:

1. **Inline**, when an order is paid. The ordinary case does not wait for a cron.
2. **`scripts/flush-outbox.mjs`**, which reports what is due, what failed, and can
   requeue failures after you have fixed the cause.

```bash
node scripts/flush-outbox.mjs                      # what is in the queue
node scripts/flush-outbox.mjs --dry-run            # what would go
node scripts/flush-outbox.mjs --requeue-failed     # after fixing an address
```

A cron trigger on the Worker is the natural third, and is worth adding once a
provider is chosen. Until then it would only retry into a provider that is not
there.

## The rules, and why each is what it is

**The failure that is recorded is more important than the success.** An audit row
is written only when a message FAILS. One per delivered email would bury the
entries that matter — price changes, refunds, role changes — under routine
success.

**A message is never deleted.** A failed send stays in the queue as `failed` with
the provider's own error, because somebody has to know that a customer was never
told.

**A failure is classified.** A 4xx from the provider (an unusable address, an
unverified domain) settles as `failed` immediately: retrying it five times over
half a day only delays the moment somebody notices. A 429 or a 5xx is transient
and is retried on a widening schedule — 1, 5, 30, 120, 480 minutes, about ten and
a half hours in total.

**One confirmation per order.** A partial unique index on
`(template, entity, entity_id)` makes a second confirmation for the same order a
no-op. Settlement can legitimately run twice — the browser returns to the callback
AND the webhook arrives — and a customer receiving two confirmations for one order
reads as a double charge.

**The queue write never fails its caller.** `queue()` catches, logs and returns
null. A payment that is real and an order that is paid must not be rolled back
because an email could not be prepared.

**Every message is sent as text AND HTML.** Both parts, generated from the same
lines so they cannot drift apart. Text alone is what a receipt reader gets; HTML
alone is a choice to make some customers read raw markup.

## Adding a second provider

`src/lib/mailer.ts` is the only file that knows about a provider. A new one is a
branch in `sendMail` and a value in `mailConfig`, and nothing else in the store
changes.
