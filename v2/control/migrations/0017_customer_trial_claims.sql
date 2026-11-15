-- A Telegram account can claim one customer trial for its lifetime.
-- The token is stored only as a digest; the token itself is deterministically
-- derived from the existing credential secret and the immutable issue time.
CREATE TABLE customer_trial_claims (
  telegram_id TEXT PRIMARY KEY CHECK(telegram_id NOT GLOB '*[^0-9]*' AND length(telegram_id) BETWEEN 1 AND 20),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  issued_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL CHECK(expires_ms>issued_ms)
);
CREATE INDEX idx_v2_customer_trial_node ON customer_trial_claims(node_id,expires_ms);
