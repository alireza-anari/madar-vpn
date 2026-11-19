-- Independent, externally authenticated mobile-carrier traffic observations.
-- These records are NOT produced by installer listener checks or node ACKs.
CREATE TABLE IF NOT EXISTS field_probes (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  operator TEXT NOT NULL CHECK(operator IN ('mci','irancell')),
  port INTEGER NOT NULL CHECK(port IN (443,8443)),
  revision INTEGER NOT NULL CHECK(revision>=1),
  observed_ms INTEGER NOT NULL,
  upload_bytes INTEGER NOT NULL CHECK(upload_bytes>=128),
  download_bytes INTEGER NOT NULL CHECK(download_bytes>=128),
  CHECK((operator='mci' AND port=443) OR (operator='irancell' AND port=8443))
);
CREATE INDEX IF NOT EXISTS idx_v2_field_probes_node
  ON field_probes(node_id,revision,observed_ms);
