CREATE TABLE IF NOT EXISTS access_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision >= 1),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_credentials_one_active
  ON client_credentials(user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS subscription_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(user_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_tokens_one_active
  ON subscription_tokens(user_id)
  WHERE revoked_at IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_subscription_tokens_revoke_active
BEFORE INSERT ON subscription_tokens
FOR EACH ROW
BEGIN
  UPDATE subscription_tokens
  SET revoked_at = NEW.created_at
  WHERE user_id = NEW.user_id
    AND revoked_at IS NULL;
END;
