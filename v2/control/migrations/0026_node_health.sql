-- Real-time node health is separate from immutable first-acceptance
-- carrier observations. A VPS heartbeat never proves carrier connectivity.
CREATE TABLE IF NOT EXISTS node_health (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  observed_ms INTEGER NOT NULL,
  xray_healthy INTEGER NOT NULL CHECK(xray_healthy IN (0,1)),
  stats_healthy INTEGER NOT NULL CHECK(stats_healthy IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_v2_node_health_recent ON node_health(observed_ms);
