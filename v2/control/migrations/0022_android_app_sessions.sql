-- Login identity tokens are independent of VPN subscriptions.
-- Entitlement still requires active quota, credentials and verified routes.
CREATE TABLE IF NOT EXISTS android_app_sessions (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
  telegram_id TEXT NOT NULL REFERENCES customers(telegram_id),
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_android_app_sessions_customer
  ON android_app_sessions(telegram_id,expires_ms);
