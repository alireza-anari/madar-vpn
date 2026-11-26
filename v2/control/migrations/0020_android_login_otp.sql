-- Add short-lived, one-time Telegram login codes and a dedicated challenge state.
-- The code hash is HMACed with the webhook secret; the encrypted copy exists
-- only so a retried Telegram webhook can safely resend the same code.
DROP INDEX IF EXISTS idx_android_login_expiry;

CREATE TABLE android_login_challenges_new (
  id TEXT PRIMARY KEY CHECK(length(id) = 24),
  verifier_hash TEXT NOT NULL CHECK(length(verifier_hash) = 64),
  telegram_id TEXT REFERENCES customers(telegram_id),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','code_sent','approved','rejected','redeeming','used','failed')),
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  otp_hash TEXT CHECK(otp_hash IS NULL OR length(otp_hash) = 64),
  otp_nonce TEXT,
  otp_ciphertext TEXT,
  otp_expires_ms INTEGER,
  otp_attempts INTEGER NOT NULL DEFAULT 0 CHECK (otp_attempts BETWEEN 0 AND 5)
);

INSERT INTO android_login_challenges_new (
  id,verifier_hash,telegram_id,state,created_ms,expires_ms
)
SELECT id,verifier_hash,telegram_id,state,created_ms,expires_ms
FROM android_login_challenges;

DROP TABLE android_login_challenges;
ALTER TABLE android_login_challenges_new RENAME TO android_login_challenges;

CREATE INDEX IF NOT EXISTS idx_android_login_expiry
  ON android_login_challenges(expires_ms, state);
