-- Roles on the account, not only on the session.
--
-- WHY THIS MIGRATION EXISTS
--
-- `sessions.role` was written at sign-in and always as 'customer', because
-- nothing recorded what role an account HAD. The consequence was that the admin
-- surface was built, tested and unreachable: there was no way to make anyone
-- staff.
--
-- The role belongs to the ACCOUNT. The session still carries a copy, because
-- authorising a request should not need a second read, but the copy is taken
-- from the account at sign-in and the account is the record.
--
-- Existing rows default to 'customer', which is the safe direction: this
-- migration cannot accidentally promote anybody.

ALTER TABLE customers ADD COLUMN role TEXT NOT NULL DEFAULT 'customer';

-- The store's owner. Set by scripts/create-account.mjs, which is the deliberate,
-- person-run path for the very first admin; every later change goes through the
-- super-admin screen and is audited.
CREATE INDEX IF NOT EXISTS idx_customers_role ON customers(role);
