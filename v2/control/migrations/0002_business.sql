-- Isolated V2 business records. Apply only to a NEW V2 D1 database.
ALTER TABLE telegram_outbox ADD COLUMN reply_markup TEXT;

CREATE TABLE IF NOT EXISTS customers (
  telegram_id TEXT PRIMARY KEY,
  locale TEXT NOT NULL DEFAULT 'fa' CHECK (locale IN ('fa','en')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff_roles (
  telegram_id TEXT NOT NULL REFERENCES customers(telegram_id),
  role TEXT NOT NULL CHECK (role IN ('admin','seller','support')),
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (telegram_id, role)
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  title_fa TEXT NOT NULL,
  title_en TEXT NOT NULL,
  price_amount INTEGER NOT NULL CHECK (price_amount >= 0),
  price_currency TEXT NOT NULL CHECK (price_currency IN ('IRT','IRR','USD')),
  quota_bytes INTEGER NOT NULL CHECK (quota_bytes > 0),
  duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 366),
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_telegram_id TEXT NOT NULL REFERENCES customers(telegram_id),
  seller_telegram_id TEXT REFERENCES customers(telegram_id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  idempotency_key TEXT NOT NULL,
  quoted_amount INTEGER NOT NULL CHECK (quoted_amount >= 0),
  quoted_currency TEXT NOT NULL CHECK (quoted_currency IN ('IRT','IRR','USD')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','receipt_submitted','approved','provisioning',
      'fulfilled','rejected','cancelled','refunded')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (customer_telegram_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_v2_orders_customer ON orders(customer_telegram_id,created_at);
CREATE INDEX IF NOT EXISTS idx_v2_orders_seller ON orders(seller_telegram_id,state);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  telegram_file_id TEXT NOT NULL,
  upload_by_telegram_id TEXT NOT NULL REFERENCES customers(telegram_id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_v2_receipts_order ON receipts(order_id);

CREATE TABLE IF NOT EXISTS support_tickets (
  id TEXT PRIMARY KEY,
  customer_telegram_id TEXT NOT NULL REFERENCES customers(telegram_id),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','waiting','closed')),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 140),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_v2_support_customer ON support_tickets(customer_telegram_id,state);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  actor_id TEXT,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  verb TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS subscription_tokens (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_v2_tokens_sub ON subscription_tokens(subscription_id);

CREATE TRIGGER IF NOT EXISTS v2_prevent_unapproved_fulfillment
BEFORE UPDATE OF state ON orders
WHEN NEW.state = 'fulfilled'
BEGIN
  SELECT CASE WHEN OLD.state != 'provisioning'
    THEN RAISE(ABORT, 'FULFILLMENT_REQUIRES_PROVISIONING') END;
END;
