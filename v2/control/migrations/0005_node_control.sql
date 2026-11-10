-- Staging-only V2 node control protocol (no direct Xray installation).
ALTER TABLE nodes ADD COLUMN desired_revision INTEGER NOT NULL DEFAULT 1
  CHECK(desired_revision>=1);
ALTER TABLE nodes ADD COLUMN acked_revision INTEGER NOT NULL DEFAULT 0
  CHECK(acked_revision>=0);
ALTER TABLE routes ADD COLUMN listen_port INTEGER
  CHECK(listen_port BETWEEN 1 AND 65535);
ALTER TABLE routes ADD COLUMN tls_hostname TEXT;
ALTER TABLE routes ADD COLUMN ws_path TEXT;

CREATE TABLE IF NOT EXISTS node_nonces (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  nonce TEXT NOT NULL CHECK(length(nonce)=32),
  created_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,nonce)
);
CREATE INDEX IF NOT EXISTS idx_v2_node_nonces_time ON node_nonces(created_ms);

CREATE TABLE IF NOT EXISTS node_acks (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  digest TEXT NOT NULL CHECK(length(digest)=64),
  status TEXT NOT NULL CHECK(status IN ('accepted','rejected')),
  observed_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,revision,digest)
);
CREATE INDEX IF NOT EXISTS idx_v2_node_acks ON node_acks(node_id,revision);

-- An acknowledged desired-state manifest is NOT proof that a VPN connection
-- works on any operator. Only external authenticated traffic tests can mark
-- a route ready, and this is intentionally a distinct process.
