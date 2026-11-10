-- V2 subscription delivery: credentials remain encrypted at rest.
-- No route is exposed without active subscription, quota, node and field readiness.
ALTER TABLE subscriptions ADD COLUMN order_id TEXT UNIQUE REFERENCES orders(id);
ALTER TABLE subscriptions ADD COLUMN max_bytes INTEGER NOT NULL DEFAULT 0 CHECK(max_bytes>=0);
ALTER TABLE subscriptions ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0 CHECK(used_bytes>=0);

CREATE TABLE IF NOT EXISTS subscription_credentials (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),
  ciphertext_b64 TEXT NOT NULL CHECK(length(ciphertext_b64) BETWEEN 20 AND 512),
  nonce_b64 TEXT NOT NULL CHECK(length(nonce_b64) BETWEEN 12 AND 24),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version=1)
);

CREATE TABLE IF NOT EXISTS route_endpoints (
  route_id TEXT PRIMARY KEY REFERENCES routes(id),
  host TEXT NOT NULL CHECK(length(host) BETWEEN 3 AND 253),
  port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
  server_name TEXT,
  ws_path TEXT,
  reality_public_key TEXT,
  reality_short_id TEXT,
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_v2_endpoints_published ON route_endpoints(published,route_id);

CREATE TRIGGER IF NOT EXISTS v2_subscription_usage_guard
BEFORE UPDATE OF used_bytes,max_bytes ON subscriptions
BEGIN
  SELECT CASE WHEN NEW.max_bytes>0 AND NEW.used_bytes>NEW.max_bytes
    THEN RAISE(ABORT,'SUBSCRIPTION_QUOTA_EXCEEDED') END;
END;
