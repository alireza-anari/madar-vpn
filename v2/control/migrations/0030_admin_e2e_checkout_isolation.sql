-- Privileged one-shot admin E2E tests are not retail checkout requests.
-- Keep at most one real open checkout per customer without deleting or
-- rewriting legacy staging test orders, subscriptions or usage history.
-- This migration is safe after 0029 and does not change existing data.
DROP INDEX IF EXISTS idx_v2_one_retail_checkout_per_customer;
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_one_retail_checkout_per_customer
  ON orders(customer_telegram_id)
  WHERE state IN ('pending','receipt_submitted','approved','provisioning')
    AND substr(idempotency_key,1,7) <> 'direct:'
    AND substr(idempotency_key,1,10) <> 'admin-e2e:';
