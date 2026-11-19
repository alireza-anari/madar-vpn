-- Admin first-hand observations are not independent signed field probes.
-- Only on isolated V2 staging, and only together with signed agent ACK.
CREATE TABLE IF NOT EXISTS admin_carrier_tests (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  operator TEXT NOT NULL CHECK(operator IN ('mci','irancell')),
  port INTEGER NOT NULL CHECK((operator='mci' AND port=443) OR (operator='irancell' AND port=8443)),
  revision INTEGER NOT NULL CHECK(revision>=1),
  actor_id TEXT NOT NULL,
  confirmed_ms INTEGER NOT NULL CHECK(confirmed_ms>0),
  source TEXT NOT NULL DEFAULT 'admin_manual' CHECK(source='admin_manual'),
  PRIMARY KEY(node_id,operator)
);
CREATE INDEX IF NOT EXISTS idx_admin_carrier_tests_recent ON admin_carrier_tests(node_id,revision,confirmed_ms);
