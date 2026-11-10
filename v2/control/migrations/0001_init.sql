-- Brand-new V2 database. Never apply to the existing sales-bot D1.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telegram_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  update_id INTEGER NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','leased','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  due_ms INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_v2_outbox_dispatch
  ON telegram_outbox(state, due_ms, lease_until_ms);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  region TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN
    ('enrolling','provisioning','ready','degraded','quarantined','retired')),
  user_limit INTEGER NOT NULL CHECK (user_limit >= 0),
  byte_limit INTEGER NOT NULL CHECK (byte_limit >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  transport TEXT NOT NULL CHECK (transport IN ('reality','wss','hysteria2','amneziawg')),
  state TEXT NOT NULL CHECK (state IN ('draft','checking','ready','degraded','quarantined')),
  verified_ms INTEGER,
  UNIQUE (node_id, transport)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  owner_telegram_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','active','suspended','expired','revoked')),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS node_allocations (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  quota_bytes INTEGER NOT NULL CHECK (quota_bytes > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','active','released')),
  UNIQUE (node_id, subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_v2_alloc_node ON node_allocations(node_id,state);

-- Capacity verification and reservation share the same SQLite write transaction.
CREATE TRIGGER IF NOT EXISTS v2_allocation_capacity BEFORE INSERT ON node_allocations
WHEN NEW.state IN ('reserved','active')
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM node_allocations
    WHERE node_id=NEW.node_id AND state IN ('reserved','active')
  ) >= (SELECT user_limit FROM nodes WHERE id=NEW.node_id)
  THEN RAISE(ABORT, 'NODE_USER_CAP_REACHED') END;
  SELECT CASE WHEN (
    SELECT COALESCE(SUM(quota_bytes),0) FROM node_allocations
    WHERE node_id=NEW.node_id AND state IN ('reserved','active')
  ) + NEW.quota_bytes > (SELECT byte_limit FROM nodes WHERE id=NEW.node_id)
  THEN RAISE(ABORT, 'NODE_BYTE_CAP_REACHED') END;
END;
CREATE TRIGGER IF NOT EXISTS v2_allocation_capacity_update BEFORE UPDATE OF
  quota_bytes, state, node_id ON node_allocations
WHEN NEW.state IN ('reserved','active')
BEGIN
  SELECT CASE WHEN (
    SELECT COUNT(*) FROM node_allocations
    WHERE node_id=NEW.node_id AND id != OLD.id AND state IN ('reserved','active')
  ) >= (SELECT user_limit FROM nodes WHERE id=NEW.node_id)
  THEN RAISE(ABORT, 'NODE_USER_CAP_REACHED') END;
  SELECT CASE WHEN (
    SELECT COALESCE(SUM(quota_bytes),0) FROM node_allocations
    WHERE node_id=NEW.node_id AND id != OLD.id AND state IN ('reserved','active')
  ) + NEW.quota_bytes > (SELECT byte_limit FROM nodes WHERE id=NEW.node_id)
  THEN RAISE(ABORT, 'NODE_BYTE_CAP_REACHED') END;
END;
