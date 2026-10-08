CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'settled')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK (
    (status = 'pending' AND settled_at IS NULL) OR
    (status = 'settled' AND settled_at IS NOT NULL)
  )
);

CREATE TABLE payment_events (
  source_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_orders_user_id_created_at
  ON orders(user_id, created_at DESC);

CREATE INDEX idx_payment_events_order_id
  ON payment_events(order_id);

CREATE TRIGGER payment_events_settle_order
AFTER INSERT ON payment_events
BEGIN
  UPDATE orders
  SET status = 'settled', settled_at = NEW.occurred_at
  WHERE id = NEW.order_id AND status = 'pending';

  INSERT INTO memberships (user_id, premium_until)
  SELECT
    orders.user_id,
    strftime(
      '%Y-%m-%dT%H:%M:%fZ',
      datetime(
        CASE
          WHEN memberships.premium_until IS NOT NULL
               AND julianday(memberships.premium_until) > julianday(NEW.occurred_at)
            THEN memberships.premium_until
          ELSE NEW.occurred_at
        END,
        '+' || orders.duration_days || ' days'
      )
    )
  FROM orders
  LEFT JOIN memberships ON memberships.user_id = orders.user_id
  WHERE orders.id = NEW.order_id
    AND orders.status = 'settled'
    AND orders.settled_at = NEW.occurred_at
  ON CONFLICT(user_id) DO UPDATE SET premium_until = excluded.premium_until;
END;
