CREATE TABLE IF NOT EXISTS node_enrollment_tokens (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_node_enrollment_tokens_expiry
  ON node_enrollment_tokens(expires_at)
  WHERE used_at IS NULL;

CREATE TABLE IF NOT EXISTS node_credentials (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_node_credentials_one_active
  ON node_credentials(node_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS node_capabilities (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  capabilities_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_health_samples (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  recorded_at TEXT NOT NULL,
  health_json TEXT NOT NULL,
  versions_json TEXT NOT NULL,
  capacity_json TEXT NOT NULL,
  PRIMARY KEY (node_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_node_health_samples_latest
  ON node_health_samples(node_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS node_policy_revisions (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  valid_until TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked_at TEXT,
  PRIMARY KEY (node_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_node_policy_revisions_latest
  ON node_policy_revisions(node_id, revision DESC);

CREATE TABLE IF NOT EXISTS telemetry_reports (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  seconds INTEGER NOT NULL CHECK (seconds >= 0),
  timestamp TEXT NOT NULL,
  observed_from TEXT,
  observed_to TEXT,
  session_id TEXT,
  PRIMARY KEY (node_id, window_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_reports_client_time
  ON telemetry_reports(client_id, timestamp);
