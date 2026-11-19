-- Staging-only V2 operator-specific routes. This metadata alone
-- never establishes port listeners or verifies mobile-network connectivity.
-- A ready route still requires signed agent ACK, independently authenticated
-- field tests, a published endpoint, and one active quota-bearing allocation.
ALTER TABLE routes ADD COLUMN operator_hint TEXT
  CHECK(operator_hint IS NULL OR operator_hint IN ('mci','irancell'));

-- One distinctly labelled REALITY route per operator per node.
CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_reality_carrier_per_node
  ON routes(node_id,operator_hint)
  WHERE transport='reality' AND operator_hint IS NOT NULL;
