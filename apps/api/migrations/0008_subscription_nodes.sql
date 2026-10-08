CREATE TABLE IF NOT EXISTS node_public_configs (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  server_name TEXT NOT NULL,
  reality_public_key TEXT NOT NULL,
  reality_short_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_policy_acks (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  acked_at TEXT NOT NULL,
  PRIMARY KEY (node_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_node_policy_acks_user_revision
  ON node_policy_acks(user_id, revision);
