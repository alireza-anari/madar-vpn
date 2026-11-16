-- Add short-lived, one-time Telegram login codes.
-- The code hash is HMACed with the webhook secret; the encrypted copy exists
-- only so a retried Telegram webhook can safely resend the same code.
ALTER TABLE android_login_challenges ADD COLUMN otp_hash TEXT
  CHECK (otp_hash IS NULL OR length(otp_hash) = 64);
ALTER TABLE android_login_challenges ADD COLUMN otp_nonce TEXT;
ALTER TABLE android_login_challenges ADD COLUMN otp_ciphertext TEXT;
ALTER TABLE android_login_challenges ADD COLUMN otp_expires_ms INTEGER;
ALTER TABLE android_login_challenges ADD COLUMN otp_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (otp_attempts BETWEEN 0 AND 5);

-- 'approved' is retained for compatibility with already-created short-lived
-- challenges. New OTP-based requests transition pending -> code_sent.
