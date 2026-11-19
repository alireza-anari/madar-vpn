-- Durable monotonic node-observed usage. Only authenticated node identities
-- may submit, and subscription balances can only increase (up to quota).
CREATE TABLE IF NOT EXISTS node_usage_reports (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  cumulative_bytes INTEGER NOT NULL CHECK(cumulative_bytes>=0),
  observed_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_v2_usage_subscription ON node_usage_reports(subscription_id);
