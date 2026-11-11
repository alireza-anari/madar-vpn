-- V2 route variants share one REALITY node and one allocation/quota.
-- Inserting these rows does not open ports or mark field acceptance.
-- Never publish without external authenticated traffic checks on each port.
CREATE TABLE IF NOT EXISTS route_carrier_variants (
  route_id TEXT NOT NULL REFERENCES routes(id),
  operator TEXT NOT NULL CHECK(operator IN ('mci','irancell')),
  host TEXT NOT NULL CHECK(length(host) BETWEEN 3 AND 253),
  port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
  server_name TEXT NOT NULL CHECK(length(server_name) BETWEEN 3 AND 253),
  ws_path TEXT,
  reality_public_key TEXT NOT NULL CHECK(length(reality_public_key)=43),
  reality_short_id TEXT NOT NULL
    CHECK(length(reality_short_id) BETWEEN 0 AND 16),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
  verified_ms INTEGER,
  PRIMARY KEY(route_id,operator)
);
CREATE INDEX IF NOT EXISTS idx_v2_carrier_variant_publish
  ON route_carrier_variants(route_id,published,verified_ms);
