-- Independent V2 queue. No changes to the sales-bot database or runner service.
CREATE TABLE IF NOT EXISTS v2_runner_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('probe','v2-install')),
  spec_json TEXT NOT NULL CHECK(length(spec_json)<2048),
  probe_id TEXT UNIQUE REFERENCES v2_runner_jobs(id),
  fingerprint TEXT,
  encrypted_credentials TEXT CHECK(encrypted_credentials IS NULL OR length(encrypted_credentials)<20000),
  state TEXT NOT NULL CHECK(state IN ('queued','leased','ready','failed')),
  safe_code TEXT,
  lease_id TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v2_runner_pending ON v2_runner_jobs(state,created_ms);
CREATE UNIQUE INDEX IF NOT EXISTS v2_runner_one_pending_per_owner ON v2_runner_jobs(owner_id) WHERE state IN ('queued','leased');
CREATE TABLE IF NOT EXISTS v2_runner_presence(id TEXT PRIMARY KEY,last_seen_ms INTEGER NOT NULL);
-- RSA-OAEP/AES-GCM sealed config, readable only by the existing host's private key.
CREATE TABLE IF NOT EXISTS v2_runner_pairing(id TEXT PRIMARY KEY,envelope_json TEXT NOT NULL,expires_ms INTEGER NOT NULL);
