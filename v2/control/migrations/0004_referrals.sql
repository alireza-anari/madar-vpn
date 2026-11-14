-- V2 referral attribution is opt-in, revocable and immutable after linking.
-- No commissions accrue without a separate approved settlement ledger.
ALTER TABLE customers ADD COLUMN seller_telegram_id TEXT REFERENCES customers(telegram_id);
CREATE INDEX IF NOT EXISTS idx_v2_customer_seller ON customers(seller_telegram_id);

CREATE TABLE IF NOT EXISTS seller_invites (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash)=64),
  seller_telegram_id TEXT NOT NULL REFERENCES customers(telegram_id),
  expires_ms INTEGER NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_v2_invites_seller ON seller_invites(seller_telegram_id,disabled);

CREATE TRIGGER IF NOT EXISTS v2_seller_link_requires_role BEFORE UPDATE OF seller_telegram_id ON customers
WHEN NEW.seller_telegram_id IS NOT OLD.seller_telegram_id
BEGIN
  SELECT CASE WHEN OLD.seller_telegram_id IS NOT NULL
    THEN RAISE(ABORT,'REFERRAL_LINK_IMMUTABLE') END;
  SELECT CASE WHEN NEW.seller_telegram_id=NEW.telegram_id
    THEN RAISE(ABORT,'SELF_REFERRAL_REJECTED') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM staff_roles sr JOIN customers c ON c.telegram_id=sr.telegram_id
    WHERE sr.telegram_id=NEW.seller_telegram_id AND sr.role='seller' AND c.state='active'
  ) THEN RAISE(ABORT,'SELLER_NOT_ACTIVE') END;
END;
