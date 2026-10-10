BEGIN;

ALTER TABLE telemetry_reports
  ADD COLUMN active_seconds_hex text,
  ADD COLUMN settlement_status text NOT NULL DEFAULT 'legacy';

ALTER TABLE telemetry_reports
  ADD CONSTRAINT telemetry_reports_active_seconds_hex_check
  CHECK (
    active_seconds_hex IS NULL OR (
      active_seconds_hex ~ '^0[0-9a-f]{15}$'
      AND active_seconds_hex <> '0000000000000000'
    )
  ),
  ADD CONSTRAINT telemetry_reports_settlement_status_check
  CHECK (settlement_status IN ('legacy', 'settled', 'unmapped'));

CREATE TABLE usage_accounting_config (
  id smallint PRIMARY KEY CHECK (id = 1),
  active_second_epoch timestamptz NOT NULL
);

INSERT INTO usage_accounting_config (id, active_second_epoch)
VALUES (1, CURRENT_TIMESTAMP);

CREATE TABLE premium_entitlement_events (
  event_order bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key text NOT NULL UNIQUE,
  effective_at timestamptz NOT NULL,
  premium_until timestamptz
);

CREATE INDEX premium_entitlement_events_user_time_idx
  ON premium_entitlement_events (user_id, effective_at, event_order);

INSERT INTO premium_entitlement_events (user_id, source_key, effective_at, premium_until)
SELECT
  memberships.user_id,
  'migration:0002:' || memberships.user_id,
  config.active_second_epoch,
  memberships.premium_until
FROM memberships
CROSS JOIN usage_accounting_config AS config
WHERE config.id = 1;

CREATE TABLE usage_active_minutes (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minute_start timestamptz NOT NULL,
  settled_mask bigint NOT NULL CHECK (settled_mask BETWEEN 0 AND 1152921504606846975),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, minute_start),
  CHECK (minute_start = date_trunc('minute', minute_start))
);

CREATE TABLE usage_debit_events (
  node_id text NOT NULL,
  window_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  minute_start timestamptz NOT NULL,
  observed_mask bigint NOT NULL CHECK (observed_mask BETWEEN 0 AND 1152921504606846975),
  new_mask bigint NOT NULL CHECK (new_mask BETWEEN 0 AND 1152921504606846975),
  debited_mask bigint NOT NULL CHECK (debited_mask BETWEEN 0 AND 1152921504606846975),
  debit_seconds integer NOT NULL CHECK (debit_seconds BETWEEN 0 AND 60),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (node_id, window_id, sequence),
  FOREIGN KEY (node_id, window_id, sequence)
    REFERENCES telemetry_reports (node_id, window_id, sequence)
    ON DELETE CASCADE,
  CHECK (minute_start = date_trunc('minute', minute_start))
);

CREATE INDEX usage_debit_events_user_minute_idx
  ON usage_debit_events (user_id, minute_start);

COMMIT;
