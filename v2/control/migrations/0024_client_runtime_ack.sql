-- V2 commercial config delivery requires per-customer runtime installation.
-- A node listening on 443/8443 with only a trial UUID is NOT a commercial node.
CREATE TABLE IF NOT EXISTS node_client_acks (
  node_id TEXT NOT NULL REFERENCES nodes(id),
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  revision INTEGER NOT NULL CHECK(revision>=1),
  credential_sha256 TEXT NOT NULL CHECK(length(credential_sha256)=64),
  observed_ms INTEGER NOT NULL,
  PRIMARY KEY(node_id,subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_v2_client_ack_subscription
  ON node_client_acks(subscription_id,observed_ms);

-- Credential changes must invalidate an acknowledgement of the old UUID.
CREATE TRIGGER IF NOT EXISTS v2_invalidate_client_ack_on_credential_change
AFTER UPDATE OF ciphertext_b64,nonce_b64,key_version ON subscription_credentials
BEGIN
  DELETE FROM node_client_acks WHERE subscription_id=NEW.subscription_id;
END;
CREATE TRIGGER IF NOT EXISTS v2_invalidate_client_ack_on_credential_remove
AFTER DELETE ON subscription_credentials
BEGIN
  DELETE FROM node_client_acks WHERE subscription_id=OLD.subscription_id;
END;
