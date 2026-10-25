-- Paid additions extend the SAME managed account. No new slot or UUID is created.
-- Durable payment and ACK state are separate from the original purchase order.
ALTER TABLE managed_accounts ADD COLUMN last_customer_upgrade_id TEXT;

CREATE TABLE customer_upgrades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  base_order_id TEXT NOT NULL REFERENCES customer_orders(id),
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  plan_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('renew','traffic','bundle')),
  price INTEGER NOT NULL CHECK(price > 0),
  currency TEXT NOT NULL CHECK(currency IN ('IRT','IRR')),
  delta_bytes INTEGER NOT NULL DEFAULT 0 CHECK(delta_bytes BETWEEN 0 AND 1000000000000),
  delta_seconds INTEGER NOT NULL DEFAULT 0 CHECK(delta_seconds BETWEEN 0 AND 31536000),
  request_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_receipt'
    CHECK(state IN ('awaiting_receipt','pending_review','approving','applied','rejected')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  decided_at INTEGER,
  decided_by TEXT,
  notified_at INTEGER,
  CHECK ((kind='renew' AND delta_seconds>0 AND delta_bytes=0)
    OR (kind='traffic' AND delta_bytes>0 AND delta_seconds=0)
    OR (kind='bundle' AND delta_bytes>0 AND delta_seconds>0)),
  UNIQUE(user_id,request_key)
);
CREATE UNIQUE INDEX customer_upgrades_open_user
  ON customer_upgrades(user_id)
  WHERE state IN ('awaiting_receipt','pending_review','approving');
CREATE INDEX customer_upgrades_user_created ON customer_upgrades(user_id,created_at DESC);
CREATE INDEX customer_upgrades_review ON customer_upgrades(state,created_at);
CREATE INDEX customer_upgrades_account ON customer_upgrades(account_id,created_at DESC);

CREATE TABLE customer_upgrade_receipts (
  upgrade_id TEXT PRIMARY KEY REFERENCES customer_upgrades(id),
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('photo','document'))
);
