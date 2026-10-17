ALTER TABLE managed_accounts ADD COLUMN seller_settlement_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE reseller_controls(
  seller_id TEXT PRIMARY KEY REFERENCES resellers(telegram_id),
  current_settlement_epoch INTEGER NOT NULL DEFAULT 0 CHECK(current_settlement_epoch>=0),
  settlement_started_at INTEGER NOT NULL DEFAULT 0 CHECK(settlement_started_at>=0),
  max_reserved_accounts INTEGER CHECK(max_reserved_accounts IS NULL OR max_reserved_accounts BETWEEN 1 AND 10000),
  max_committed_bytes INTEGER CHECK(max_committed_bytes IS NULL OR (max_committed_bytes>0 AND max_committed_bytes<=1000000000000000)),
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE reseller_settlements(
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES resellers(telegram_id),
  epoch INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  config_count INTEGER NOT NULL,
  sold_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL,
  live_count INTEGER NOT NULL,
  blocked_count INTEGER NOT NULL,
  expired_count INTEGER NOT NULL,
  revoked_count INTEGER NOT NULL,
  exhausted_count INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(seller_id,epoch)
);

CREATE TABLE reseller_settlement_nodes(
  settlement_id TEXT NOT NULL REFERENCES reseller_settlements(id),
  node_id TEXT NOT NULL REFERENCES nodes(id),
  config_count INTEGER NOT NULL,
  sold_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL,
  PRIMARY KEY(settlement_id,node_id)
);

CREATE TABLE node_capacity_alert_state(
  node_id TEXT PRIMARY KEY REFERENCES nodes(id),
  level INTEGER NOT NULL DEFAULT 0 CHECK(level IN (0,80,90,95)),
  sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence>=0),
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX managed_accounts_seller_settlement ON managed_accounts(seller_id,seller_settlement_epoch,created_at);
CREATE INDEX reseller_settlements_seller ON reseller_settlements(seller_id,ended_at DESC);
