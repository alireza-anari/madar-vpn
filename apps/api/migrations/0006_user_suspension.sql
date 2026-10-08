ALTER TABLE users ADD COLUMN suspended_at TEXT;

CREATE INDEX idx_users_suspended_at
  ON users(suspended_at);
