ALTER TABLE nodes ADD COLUMN max_accounts_unlimited INTEGER NOT NULL DEFAULT 0 CHECK(max_accounts_unlimited IN (0,1));
