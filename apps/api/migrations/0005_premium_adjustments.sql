CREATE TABLE premium_adjustments (
  unique_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  premium_until TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_premium_adjustments_user_id
  ON premium_adjustments(user_id);

CREATE TRIGGER premium_adjustments_apply
AFTER INSERT ON premium_adjustments
BEGIN
  INSERT INTO memberships (user_id, premium_until)
  VALUES (NEW.user_id, NEW.premium_until)
  ON CONFLICT(user_id) DO UPDATE SET premium_until = excluded.premium_until;
END;
