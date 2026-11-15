-- V2-only conversational actions for administrator and customer bot panels.
-- No changes to V1, VPN nodes, payment flags or subscription credentials.
CREATE TABLE IF NOT EXISTS v2_bot_input_sessions (
  telegram_id TEXT PRIMARY KEY REFERENCES customers(telegram_id),
  mode TEXT NOT NULL CHECK(mode IN ('plan_draft','grant_seller','grant_support','revoke_seller','revoke_support','ticket_reply')),
  context_id TEXT,
  expires_ms INTEGER NOT NULL CHECK(expires_ms>0)
);
CREATE INDEX IF NOT EXISTS idx_v2_bot_input_expiry ON v2_bot_input_sessions(expires_ms);
