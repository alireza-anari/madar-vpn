CREATE TABLE IF NOT EXISTS node_availability_alert_state (
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'up' CHECK(status IN ('up','down')),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
  changed_at INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0
);
