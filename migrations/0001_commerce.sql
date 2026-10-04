-- Ozikoro Store — commerce schema (Cloudflare D1 / SQLite)
--
-- Money is stored in MINOR UNITS (kobo) as INTEGER, always. Paystack expects
-- kobo, and floating-point naira arithmetic produces totals that are off by a
-- kobo in ways that only show up in a customer's bank statement. Nothing in this
-- schema stores a currency amount as a float.
--
-- Stock is tracked per variant, never on the product, because a tee with no
-- Medium left is not out of stock.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- collections

CREATE TABLE IF NOT EXISTS collections (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  image_url    TEXT NOT NULL DEFAULT '',
  position     INTEGER NOT NULL DEFAULT 0,
  is_visible   INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------- products

CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  category        TEXT NOT NULL,
  collection_id   TEXT REFERENCES collections(id) ON DELETE SET NULL,
  -- Denormalised category text: the storefront groups by it and the original
  -- catalogue is category-first. Kept in step with collection_id at write time.
  description     TEXT NOT NULL DEFAULT '',
  details         TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  image_url       TEXT NOT NULL DEFAULT '',
  image_alt       TEXT NOT NULL DEFAULT '',
  price_minor     INTEGER NOT NULL,              -- display/default variant price
  currency        TEXT NOT NULL DEFAULT 'NGN',
  -- 'active'  purchasable
  -- 'draft'   not yet public
  -- 'archived' discontinued; page stays up with useful redirects/notes
  status          TEXT NOT NULL DEFAULT 'draft',
  is_featured     INTEGER NOT NULL DEFAULT 0,
  position        INTEGER NOT NULL DEFAULT 0,
  seo_title       TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  -- Set when an item is made to order: stock is not decremented, lead time shown.
  made_to_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

-- ------------------------------------------------------------------- variants

CREATE TABLE IF NOT EXISTS product_variants (
  id             TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku            TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,                  -- 'Medium', 'A2', 'Hardcover'
  price_minor    INTEGER NOT NULL,               -- variant price, authoritative
  compare_at_minor INTEGER,                      -- optional struck-through price
  stock          INTEGER NOT NULL DEFAULT 0,
  weight_grams   INTEGER NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (stock >= 0),
  CHECK (price_minor >= 0)
);

CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

-- ------------------------------------------------------------------- customers

CREATE TABLE IF NOT EXISTS customers (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT,                  -- NULL until the account is claimed
  password_salt  TEXT,
  name           TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS addresses (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT 'Delivery',
  first_name   TEXT NOT NULL,
  last_name    TEXT NOT NULL,
  line1        TEXT NOT NULL,
  line2        TEXT NOT NULL DEFAULT '',
  city         TEXT NOT NULL,
  region       TEXT NOT NULL DEFAULT '',
  postal_code  TEXT NOT NULL DEFAULT '',
  country      TEXT NOT NULL DEFAULT 'Nigeria',
  phone        TEXT NOT NULL DEFAULT '',
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_addresses_customer ON addresses(customer_id);

-- ------------------------------------------------------------------- sessions

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,        -- the SHA-256 of the cookie value, never the value
  customer_id  TEXT REFERENCES customers(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'customer',
  -- Roles: customer | store_admin | fulfilment | content_manager | super_admin
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent   TEXT NOT NULL DEFAULT '',
  ip_hash      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_customer ON sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ----------------------------------------------------------------------- carts
-- A cart is server-side so a total cannot be edited by the browser, and so a
-- customer can pick the basket up on another device.
CREATE TABLE IF NOT EXISTS carts (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT REFERENCES customers(id) ON DELETE SET NULL,
  currency     TEXT NOT NULL DEFAULT 'NGN',
  -- 'open' | 'converted' | 'abandoned'
  status       TEXT NOT NULL DEFAULT 'open',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id           TEXT PRIMARY KEY,
  cart_id      TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id   TEXT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity     INTEGER NOT NULL,
  -- Price captured when the item was added. Kept so a later price change is
  -- visible rather than silent, and so the customer sees what they agreed to.
  added_price_minor INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cart_id, variant_id),
  CHECK (quantity > 0)
);

-- ---------------------------------------------------------------------- orders

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  number             TEXT NOT NULL UNIQUE,       -- OZK-10428
  customer_id        TEXT REFERENCES customers(id) ON DELETE SET NULL,
  email              TEXT NOT NULL,
  -- pending   created, awaiting payment
  -- paid      payment server-verified
  -- processing / fulfilled / shipped / delivered
  -- cancelled / refunded / partially_refunded
  -- failed    payment did not succeed
  status             TEXT NOT NULL DEFAULT 'pending',
  payment_status     TEXT NOT NULL DEFAULT 'unpaid',  -- unpaid|paid|failed|refunded|partially_refunded
  fulfilment_status  TEXT NOT NULL DEFAULT 'unfulfilled', -- unfulfilled|partial|fulfilled|returned
  currency           TEXT NOT NULL DEFAULT 'NGN',
  subtotal_minor     INTEGER NOT NULL DEFAULT 0,
  discount_minor     INTEGER NOT NULL DEFAULT 0,
  shipping_minor     INTEGER NOT NULL DEFAULT 0,
  tax_minor          INTEGER NOT NULL DEFAULT 0,
  total_minor        INTEGER NOT NULL DEFAULT 0,
  discount_code      TEXT NOT NULL DEFAULT '',
  shipping_method    TEXT NOT NULL DEFAULT '',
  shipping_address   TEXT NOT NULL DEFAULT '{}',  -- JSON snapshot, not a live FK
  billing_address    TEXT NOT NULL DEFAULT '{}',
  customer_note      TEXT NOT NULL DEFAULT '',
  admin_note         TEXT NOT NULL DEFAULT '',
  -- A confirmed order is one whose payment was verified server-side. Nothing
  -- sets this except the verification path.
  paid_at            TEXT,
  cancelled_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email);

-- Order lines are a SNAPSHOT. A product renamed or repriced tomorrow must not
-- rewrite what a customer bought today.
CREATE TABLE IF NOT EXISTS order_items (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id        TEXT,
  variant_id        TEXT,
  -- Retained for fulfilment even if the product is later deleted.
  product_slug      TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL,
  variant_title     TEXT NOT NULL DEFAULT '',
  sku               TEXT NOT NULL DEFAULT '',
  image_url         TEXT NOT NULL DEFAULT '',
  unit_price_minor  INTEGER NOT NULL,
  quantity          INTEGER NOT NULL,
  line_total_minor  INTEGER NOT NULL,
  quantity_fulfilled INTEGER NOT NULL DEFAULT 0,
  quantity_refunded  INTEGER NOT NULL DEFAULT 0,
  CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ------------------------------------------------------------------- payments

CREATE TABLE IF NOT EXISTS payments (
  id                  TEXT PRIMARY KEY,
  order_id            TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL DEFAULT 'paystack',
  -- The reference WE generated and sent. Unique so a retry cannot double-charge.
  reference           TEXT NOT NULL UNIQUE,
  provider_reference  TEXT,
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'NGN',
  -- initialized | pending | success | failed | abandoned | reversed
  status              TEXT NOT NULL DEFAULT 'initialized',
  channel             TEXT,
  gateway_response    TEXT,
  -- Idempotency: set the first time a webhook or verify call settles this row.
  settled_at          TEXT,
  verified_at         TEXT,
  raw                 TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- Every webhook delivery is recorded before it is acted on, so a replayed event
-- can be recognised as a replay.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  reference    TEXT NOT NULL DEFAULT '',
  -- SHA-256 of the raw body: the same event delivered twice has one hash.
  body_hash    TEXT NOT NULL,
  processed_at TEXT,
  result       TEXT NOT NULL DEFAULT '',
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, body_hash)
);

-- ------------------------------------------------------------------ shipments

CREATE TABLE IF NOT EXISTS shipments (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier        TEXT NOT NULL DEFAULT '',
  tracking_number TEXT NOT NULL DEFAULT '',
  tracking_url   TEXT NOT NULL DEFAULT '',
  -- pending | dispatched | in_transit | delivered | returned
  status         TEXT NOT NULL DEFAULT 'pending',
  shipped_at     TEXT,
  delivered_at   TEXT,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shipments_order ON shipments(order_id);

-- ------------------------------------------------------------------ discounts

CREATE TABLE IF NOT EXISTS discounts (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- percentage | fixed | free_shipping
  kind              TEXT NOT NULL,
  value             INTEGER NOT NULL DEFAULT 0,  -- percent 0-100, or minor units
  minimum_subtotal_minor INTEGER NOT NULL DEFAULT 0,
  -- NULL means unlimited
  max_redemptions   INTEGER,
  redemption_count  INTEGER NOT NULL DEFAULT 0,
  starts_at         TEXT,
  ends_at           TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -------------------------------------------------------------------- refunds

CREATE TABLE IF NOT EXISTS refunds (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id    TEXT REFERENCES payments(id) ON DELETE SET NULL,
  amount_minor  INTEGER NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  -- requested | approved | processing | completed | failed
  status        TEXT NOT NULL DEFAULT 'requested',
  provider_reference TEXT,
  restock       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

-- --------------------------------------------------------------- audit trail
-- Price, inventory, refund and order-state changes are recorded here. The handoff
-- asks for an audit of exactly those four things, so `entity` is constrained to
-- them at the application layer.
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,               -- order.status_changed, variant.stock_changed …
  entity      TEXT NOT NULL,               -- 'product' | 'variant' | 'order' | 'refund' | 'discount'
  entity_id   TEXT NOT NULL,
  before      TEXT NOT NULL DEFAULT '{}',
  after       TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- ------------------------------------------------------- rate limiting / abuse
-- Account and checkout endpoints are rate limited. Counters live in D1 rather
-- than in memory because a Worker has no shared memory between isolates.
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start TEXT NOT NULL
);

-- --------------------------------------------------------- inventory ledger
-- Every stock movement, so "why is this number 3" has an answer.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id          TEXT PRIMARY KEY,
  variant_id  TEXT NOT NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,   -- order_placed | order_cancelled | refund_restock | manual | seed
  order_id    TEXT,
  note        TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_variant ON inventory_movements(variant_id);

-- ------------------------------------------------------------ contact messages
-- The store's contact form writes here. The design preview accepted a message
-- and threw it away ("your message was not sent"); a live store cannot.
CREATE TABLE IF NOT EXISTS contact_messages (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  topic        TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  -- new | read | answered
  status       TEXT NOT NULL DEFAULT 'new',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_created ON contact_messages(created_at DESC);
