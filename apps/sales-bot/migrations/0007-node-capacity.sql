ALTER TABLE nodes ADD COLUMN max_accounts INTEGER NOT NULL DEFAULT 100 CHECK(max_accounts BETWEEN 1 AND 10000);
CREATE INDEX managed_accounts_capacity ON managed_accounts(node_id,state,valid_until);
