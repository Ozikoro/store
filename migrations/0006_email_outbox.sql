-- Outbound email.
--
-- WHY AN OUTBOX AND NOT A DIRECT SEND
--
-- Sending inside the request that settles a payment is the obvious thing and the
-- wrong one. The gateway is holding a connection open, our isolate can be evicted
-- at any moment, and an HTTP call to a mail provider is exactly the kind of work
-- that fails transiently. Anything that fails there is lost, and what is lost is
-- a customer's only record that they paid.
--
-- So the store WRITES DOWN what it owes the customer, in the same transaction
-- that makes the change, and a separate step delivers it. The consequences are
-- the ones that matter:
--
--   * A delivery failure is retried, not forgotten. `attempts` and
--     `next_attempt_at` are the retry state.
--   * Nothing depends on a provider being configured. Before one is, every
--     message is queued and visible, and the moment a key exists they go out.
--   * The owner can SEE what the store would have sent. An outbox is the only
--     way to answer "did the customer get their confirmation?" after the fact.
--
-- WHAT IS NOT STORED, ON PURPOSE
--
-- No card data, no passwords. A message body contains what the customer already
-- knows plus what they need (order number, items, total, address). It is a record
-- of correspondence, not a copy of the database.

CREATE TABLE IF NOT EXISTS email_outbox (
  id            TEXT PRIMARY KEY,
  -- The template that produced it. A narrow set, so the admin can group by it.
  template      TEXT NOT NULL,
  to_email      TEXT NOT NULL,
  to_name       TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  body_html     TEXT NOT NULL DEFAULT '',
  -- What this message is ABOUT, so an operator can find it from an order.
  entity        TEXT NOT NULL DEFAULT '',
  entity_id     TEXT NOT NULL DEFAULT '',

  -- pending | sending | sent | failed | cancelled
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT NOT NULL DEFAULT '',
  -- The provider's own id, for matching a bounce or a complaint back to a send.
  provider_message_id TEXT,

  -- Batched sending takes the oldest that is due, so this is indexed.
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),

  -- A message with no recipient is a bug in the caller, not a queue entry.
  CHECK (length(to_email) > 3),
  CHECK (length(subject) > 0)
);

-- The send loop's query: due, pending, oldest first.
CREATE INDEX IF NOT EXISTS idx_outbox_due ON email_outbox(status, next_attempt_at);

-- Finding everything about one order.
CREATE INDEX IF NOT EXISTS idx_outbox_entity ON email_outbox(entity, entity_id);

-- ONE CONFIRMATION PER ORDER, AND THIS IS WHAT ENFORCES IT.
--
-- The settlement path can legitimately run twice: the customer's browser returns
-- to the callback AND the webhook arrives, and either may win. Both take the
-- same conditional UPDATE, so only one settles — but a bug or a retry could
-- still reach the queue twice, and a customer receiving two confirmations for
-- one order is the kind of thing that reads as a double charge. A partial unique
-- index makes the second insert a no-op instead of a nuisance.
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_once_per_entity
  ON email_outbox(template, entity, entity_id)
  WHERE entity != '' AND entity_id != '';
