ALTER TABLE plans ADD COLUMN quota_bytes INTEGER CHECK(quota_bytes IS NULL OR (quota_bytes > 0 AND quota_bytes <= 1000000000000));

CREATE TABLE customer_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  price INTEGER NOT NULL CHECK(price > 0),
  currency TEXT NOT NULL CHECK(currency IN ('IRT','IRR')),
  quota_bytes INTEGER NOT NULL CHECK(quota_bytes > 0 AND quota_bytes <= 1000000000000),
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 60 AND 31536000),
  request_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_receipt'
    CHECK(state IN ('awaiting_receipt','pending_review','approving','approved','rejected')),
  account_id TEXT UNIQUE REFERENCES managed_accounts(id),
  reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  UNIQUE(user_id, request_key)
);
CREATE INDEX customer_orders_user_created ON customer_orders(user_id, created_at DESC);
CREATE INDEX customer_orders_review ON customer_orders(state, created_at);
CREATE TABLE customer_receipts (
  order_id TEXT PRIMARY KEY REFERENCES customer_orders(id),
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('photo','document'))
);
