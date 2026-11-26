ALTER TABLE nodes ADD COLUMN retail_enabled INTEGER NOT NULL DEFAULT 0 CHECK(retail_enabled IN (0,1));
ALTER TABLE orders ADD COLUMN held_node TEXT REFERENCES nodes(id);
ALTER TABLE orders ADD COLUMN quoted_bytes INTEGER CHECK(quoted_bytes > 0);
ALTER TABLE orders ADD COLUMN quoted_days INTEGER CHECK(quoted_days BETWEEN 1 AND 366);
ALTER TABLE orders ADD COLUMN pay_until_ms INTEGER;
CREATE INDEX retail_open_holds ON orders(held_node,state) WHERE held_node IS NOT NULL;

-- Provisioning converts a hold into a node allocation in one D1 batch.
CREATE VIEW retail_capacity_usage AS
SELECT node_id,quota_bytes,id AS allocation_id,NULL AS order_id FROM node_allocations
 WHERE state IN ('reserved','active')
UNION ALL
SELECT held_node,quoted_bytes,NULL,id FROM orders
 WHERE held_node IS NOT NULL AND state IN ('pending','receipt_submitted','approved');

CREATE TRIGGER retail_allocation_insert BEFORE INSERT ON node_allocations
WHEN NEW.state IN ('reserved','active') AND EXISTS(
 SELECT 1 FROM orders WHERE held_node=NEW.node_id AND state IN ('pending','receipt_submitted','approved')
)
BEGIN
 SELECT CASE WHEN COUNT(u.node_id)+1>n.user_limit OR COALESCE(SUM(u.quota_bytes),0)+NEW.quota_bytes>n.byte_limit
 THEN RAISE(ABORT,'NODE_RETAIL_CAPACITY_HELD') END
 FROM nodes n LEFT JOIN retail_capacity_usage u ON u.node_id=n.id WHERE n.id=NEW.node_id
 GROUP BY n.id;
END;
CREATE TRIGGER retail_allocation_update BEFORE UPDATE OF state,quota_bytes,node_id ON node_allocations
WHEN NEW.state IN ('reserved','active') AND EXISTS(
 SELECT 1 FROM orders WHERE held_node=NEW.node_id AND state IN ('pending','receipt_submitted','approved')
)
BEGIN
 SELECT CASE WHEN COUNT(u.node_id)+1>n.user_limit OR COALESCE(SUM(u.quota_bytes),0)+NEW.quota_bytes>n.byte_limit
 THEN RAISE(ABORT,'NODE_RETAIL_CAPACITY_HELD') END
 FROM nodes n LEFT JOIN retail_capacity_usage u ON u.node_id=n.id AND u.allocation_id IS NOT OLD.id
 WHERE n.id=NEW.node_id GROUP BY n.id;
END;
