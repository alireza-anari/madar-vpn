-- Preserve one open retail checkout per customer while allowing independent
-- privileged direct issues, each guarded by its existing idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_one_retail_checkout_per_customer
  ON orders(customer_telegram_id)
  WHERE state IN ('pending','receipt_submitted','approved','provisioning')
    AND substr(idempotency_key,1,7) <> 'direct:';

DROP INDEX IF EXISTS idx_v2_one_checkout_per_customer;
