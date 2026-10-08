CREATE TABLE credit_ledger_v2 (
  unique_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'ad', 'usage', 'manual')),
  free_day TEXT NOT NULL,
  delta_seconds INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  node_id TEXT,
  session_id TEXT,
  sequence INTEGER
);

INSERT INTO credit_ledger_v2 (
  unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
  node_id, session_id, sequence
)
SELECT
  unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
  node_id, session_id, sequence
FROM credit_ledger;

DROP TABLE credit_ledger;
ALTER TABLE credit_ledger_v2 RENAME TO credit_ledger;

CREATE INDEX idx_credit_ledger_user_day
  ON credit_ledger(user_id, free_day);
