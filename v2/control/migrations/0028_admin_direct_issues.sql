-- V2-only privileged direct config issuance, independent of paid plans.
-- Records immutable owner-selected label, node, data cap and validity.
CREATE TABLE IF NOT EXISTS admin_direct_issues (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES customers(telegram_id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 2 AND 80),
  quota_bytes INTEGER NOT NULL CHECK(quota_bytes BETWEEN 1073741824 AND 1073741824000),
  duration_days INTEGER NOT NULL CHECK(duration_days BETWEEN 1 AND 365),
  created_ms INTEGER NOT NULL CHECK(created_ms>0)
);
CREATE INDEX IF NOT EXISTS idx_admin_direct_issues_actor ON admin_direct_issues(actor_id,created_ms);
