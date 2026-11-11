-- V2-only staged remote installation jobs, no production migrations.
CREATE TABLE IF NOT EXISTS node_bootstrap_jobs (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE REFERENCES nodes(id),
  ip TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('aria-cutover','fresh')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','dispatching','dispatched','installed','failed')),
  error_code TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_bootstrap_jobs_state ON node_bootstrap_jobs(state,created_ms);
CREATE TABLE IF NOT EXISTS node_trial_credentials (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  ciphertext_b64 TEXT NOT NULL,
  nonce_b64 TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK(key_version=1),
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_trial_links (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  owner_id TEXT NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_v2_trial_links_node ON node_trial_links(node_id,expires_ms);
