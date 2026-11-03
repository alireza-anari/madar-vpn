-- Default-off safety gate; existing accounts and nodes retain empty flow.
ALTER TABLE nodes ADD COLUMN vision_opt_in INTEGER NOT NULL DEFAULT 0 CHECK(vision_opt_in IN (0,1));
ALTER TABLE managed_accounts ADD COLUMN connection_flow TEXT NOT NULL DEFAULT '' CHECK(connection_flow IN ('','xtls-rprx-vision'));
