-- Isolated V2 queued Telegram actions and safe human-review checkout.
-- Never run against V1 production.
CREATE TABLE IF NOT EXISTS telegram_inbox (
  update_id INTEGER PRIMARY KEY CHECK (update_id >= 0),
  chat_id TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (length(event_json) <= 8192),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','leased','done','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 16),
  due_ms INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_v2_inbox_due
  ON telegram_inbox(state, due_ms, lease_until_ms, update_id);
CREATE INDEX IF NOT EXISTS idx_v2_inbox_chat ON telegram_inbox(chat_id, state, update_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_one_checkout_per_customer
  ON orders(customer_telegram_id)
  WHERE state IN ('pending','receipt_submitted','approved','provisioning');

CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_single_active_receipt
  ON receipts(order_id) WHERE state IN ('pending','accepted');

CREATE TABLE IF NOT EXISTS customer_sessions (
  telegram_id TEXT PRIMARY KEY REFERENCES customers(telegram_id),
  mode TEXT NOT NULL CHECK(mode IN ('support')),
  expires_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_notifications (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(body) <= 4096),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','leased','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 16),
  due_ms INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_v2_notifications_due
  ON telegram_notifications(state, due_ms, lease_until_ms);

CREATE TRIGGER IF NOT EXISTS v2_receipt_requires_owned_pending_order
BEFORE INSERT ON receipts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM orders o
      WHERE o.id = NEW.order_id
      AND o.customer_telegram_id = NEW.upload_by_telegram_id
      AND o.state = 'pending'
  ) THEN RAISE(ABORT, 'RECEIPT_REQUIRES_OWN_PENDING_ORDER') END;
END;

CREATE TRIGGER IF NOT EXISTS v2_prevent_unapproved_order_transition
BEFORE UPDATE OF state ON orders
BEGIN
  SELECT CASE
    WHEN NEW.state = OLD.state THEN NULL
    WHEN OLD.state='pending' AND NEW.state IN ('receipt_submitted','cancelled') THEN NULL
    WHEN OLD.state='receipt_submitted' AND NEW.state IN ('approved','rejected') THEN NULL
    WHEN OLD.state='approved' AND NEW.state IN ('provisioning','refunded') THEN NULL
    WHEN OLD.state='provisioning' AND NEW.state IN ('fulfilled','refunded') THEN NULL
    WHEN OLD.state='fulfilled' AND NEW.state='refunded' THEN NULL
    ELSE RAISE(ABORT,'ORDER_STATE_TRANSITION_REJECTED')
  END;
END;
