CREATE TABLE IF NOT EXISTS credit_ledger (
  unique_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'ad', 'usage')),
  free_day TEXT NOT NULL,
  delta_seconds INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  node_id TEXT,
  session_id TEXT,
  sequence INTEGER
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_day
  ON credit_ledger(user_id, free_day);

CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  premium_until TEXT
);

CREATE TABLE IF NOT EXISTS usage_sessions (
  node_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (node_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_usage_sessions_user_id
  ON usage_sessions(user_id);
