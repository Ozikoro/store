-- The storefront visibility switch.
--
-- WHY THIS IS A SETTING AND NOT A BUILD FLAG
--
-- Opening and closing a shop is an operational decision: a launch date, a stock
-- problem, a mistake spotted at the wrong moment. A build flag turns that into a
-- code change and a deploy, which in practice means it does not get done when it
-- matters. The switch lives in the settings table so the person responsible for
-- the shop can throw it.
--
-- WRITTEN AS '1' EXPLICITLY. The reader treats a missing or unreadable row as
-- CLOSED, because a visibility switch must fail closed — the alternative is
-- putting a half-prepared shop in front of strangers the moment one query fails.
-- This row is what keeps an already-working deployment open through the change.
--
-- `kind = 'none'` — the value is read by the gate and must never be emitted as a
-- <meta> tag. The head builder keys off `kind`, so 'none' is what tells it so.
--
-- `seo.noindex_admin` is its neighbour: a second switch of the same shape, which
-- is why the pattern is worth following rather than inventing a second mechanism.

PRAGMA foreign_keys = ON;

INSERT INTO settings (key, value, kind, label, help) VALUES
  ('store.open', '1', 'none', 'Storefront open to the public',
   'Set to 0 to hide the shop behind a "coming soon" page. While it is 0, visitors see only the coming-soon page; the admin, the payment webhook and the identity provider keep working, because a payment taken before the shop closed must still be able to settle.')
ON CONFLICT(key) DO UPDATE SET
  kind  = excluded.kind,
  label = excluded.label,
  help  = excluded.help;
-- NOTE: `value` is deliberately NOT touched on conflict. Re-running migrations
-- must not reopen a shop somebody closed on purpose.
