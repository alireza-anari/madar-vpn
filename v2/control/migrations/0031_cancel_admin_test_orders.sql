DROP TRIGGER IF EXISTS v2_prevent_unapproved_order_transition;
CREATE TRIGGER v2_prevent_unapproved_order_transition
BEFORE UPDATE OF state ON orders
BEGIN
  SELECT CASE
    WHEN NEW.state = OLD.state THEN NULL
    WHEN OLD.state IN ('approved','provisioning') AND NEW.state='cancelled'
      AND OLD.plan_id='v2-admin-e2e-100mb-1day' AND OLD.quoted_amount=0
      AND substr(OLD.idempotency_key,1,10)='admin-e2e:'
      AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.order_id=OLD.id AND s.state<>'revoked')
      THEN NULL
    WHEN OLD.state='pending' AND NEW.state IN ('receipt_submitted','cancelled') THEN NULL
    WHEN OLD.state='receipt_submitted' AND NEW.state IN ('approved','rejected') THEN NULL
    WHEN OLD.state='approved' AND NEW.state IN ('provisioning','refunded') THEN NULL
    WHEN OLD.state='provisioning' AND NEW.state IN ('fulfilled','refunded') THEN NULL
    WHEN OLD.state='fulfilled' AND NEW.state='refunded' THEN NULL
    ELSE RAISE(ABORT,'ORDER_STATE_TRANSITION_REJECTED')
  END;
END;

-- The signed removal ACK still owns capacity release.
CREATE TRIGGER v2_cancel_revoked_test_order AFTER UPDATE OF state ON subscriptions
WHEN NEW.state='revoked' AND OLD.state<>'revoked'
BEGIN
  UPDATE orders SET state='cancelled',updated_at=CURRENT_TIMESTAMP
  WHERE id=NEW.order_id AND state='provisioning' AND quoted_amount=0
    AND plan_id='v2-admin-e2e-100mb-1day' AND substr(idempotency_key,1,10)='admin-e2e:';
END;

UPDATE orders SET state='cancelled',updated_at=CURRENT_TIMESTAMP
WHERE state='provisioning' AND quoted_amount=0 AND plan_id='v2-admin-e2e-100mb-1day'
  AND substr(idempotency_key,1,10)='admin-e2e:'
  AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.order_id=orders.id AND s.state='revoked');
