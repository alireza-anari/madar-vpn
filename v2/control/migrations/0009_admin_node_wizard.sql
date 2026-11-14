-- Isolated V2-only phone-first server enrollment.
-- No credentials, SSH keys, IP addresses or remote secrets are collected.
CREATE TABLE IF NOT EXISTS admin_node_sessions (
  telegram_id TEXT PRIMARY KEY REFERENCES customers(telegram_id),
  mode TEXT NOT NULL CHECK (mode='add'),
  expires_ms INTEGER NOT NULL CHECK (expires_ms>0)
);
