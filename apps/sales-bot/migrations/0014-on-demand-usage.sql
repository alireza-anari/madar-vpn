CREATE TABLE usage_refresh_requests(account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,node_id TEXT NOT NULL REFERENCES nodes(id),requested_at INTEGER NOT NULL CHECK(requested_at>=0));
CREATE INDEX usage_refresh_requests_node ON usage_refresh_requests(node_id,requested_at);
