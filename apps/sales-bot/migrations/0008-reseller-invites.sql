CREATE TABLE reseller_invites(token_hash TEXT PRIMARY KEY,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,claimed_by TEXT,claimed_at INTEGER);
