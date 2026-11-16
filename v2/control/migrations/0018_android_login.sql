-- One-time Android app authorization. No plaintext login verifier or subscription key is stored.
-- Run only against the isolated V2 control D1.
CREATE TABLE IF NOT EXISTS android_login_challenges (
  id TEXT PRIMARY KEY CHECK(length(id) = 24),
  verifier_hash TEXT NOT NULL CHECK(length(verifier_hash) = 64),
  telegram_id TEXT REFERENCES customers(telegram_id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','approved','rejected','redeeming','used','failed')),
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_android_login_expiry
  ON android_login_challenges(expires_ms, state);
