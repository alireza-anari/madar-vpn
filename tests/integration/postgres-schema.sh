#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"

migrations_dir="packages/database/src/migrations"
if [[ ! -d "$migrations_dir" ]]; then
  echo "missing authoritative PostgreSQL migrations directory: $migrations_dir" >&2
  exit 1
fi

mapfile -t migrations < <(find "$migrations_dir" -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)
if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "no authoritative PostgreSQL migrations found" >&2
  exit 1
fi

for migration in "${migrations[@]}"; do
  psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null
done

psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  required_tables text[] := ARRAY[
    'users', 'login_tokens', 'sessions', 'credit_ledger', 'memberships',
    'usage_sessions', 'premium_adjustments', 'app_settings', 'nodes', 'plans',
    'missions', 'notification_drafts', 'audit_log', 'access_profiles',
    'client_credentials', 'subscription_tokens', 'node_public_configs',
    'node_policy_acks', 'orders', 'payment_events', 'mission_submissions',
    'verified_referrals', 'push_subscriptions', 'node_enrollment_tokens',
    'node_credentials', 'node_capabilities', 'node_health_samples',
    'node_policy_revisions', 'telemetry_reports', 'usage_accounting_config',
    'premium_entitlement_events', 'usage_active_minutes', 'usage_debit_events'
  ];
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY required_tables LOOP
    IF to_regclass('public.' || table_name) IS NULL THEN
      RAISE EXCEPTION 'missing required table: %', table_name;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  speed integer;
  epoch_count integer;
  epoch timestamptz;
BEGIN
  SELECT free_speed_kbps INTO speed FROM app_settings WHERE id = 1;
  IF speed <> 5000 THEN
    RAISE EXCEPTION 'default free speed must be 5000 kbps, got %', speed;
  END IF;

  SELECT count(*), min(active_second_epoch)
    INTO epoch_count, epoch
    FROM usage_accounting_config
    WHERE id = 1;
  IF epoch_count <> 1 OR epoch IS NULL THEN
    RAISE EXCEPTION 'active-second accounting epoch must exist exactly once';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'telemetry_reports'
        AND column_name = 'active_seconds_hex'
  ) OR NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'telemetry_reports'
        AND column_name = 'settlement_status'
  ) THEN
    RAISE EXCEPTION 'telemetry bitmap settlement columns are missing';
  END IF;
END $$;

INSERT INTO users (id, email, role, verified_at)
VALUES ('schema-user-1', 'User@Example.COM', 'user', '2026-10-08T12:00:00.000Z');

DO $$
BEGIN
  BEGIN
    INSERT INTO users (id, email, role, verified_at)
    VALUES ('schema-user-2', 'user@example.com', 'user', '2026-10-08T12:00:00.000Z');
    RAISE EXCEPTION 'canonical email uniqueness was not enforced';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END $$;

INSERT INTO credit_ledger (
  unique_key, user_id, kind, free_day, delta_seconds, occurred_at
) VALUES (
  'initial:schema-user-1', 'schema-user-1', 'initial', '2026-10-08', 1800, '2026-10-08T12:00:00.000Z'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO credit_ledger (
      unique_key, user_id, kind, free_day, delta_seconds, occurred_at
    ) VALUES (
      'initial:schema-user-1', 'schema-user-1', 'initial', '2026-10-08', 1800, '2026-10-08T12:00:01.000Z'
    );
    RAISE EXCEPTION 'ledger idempotency key was not enforced';
  EXCEPTION
    WHEN unique_violation THEN NULL;
  END;
END $$;

INSERT INTO nodes (id, name, status, created_at)
VALUES ('schema-node-1', 'Schema node', 'enrolled', '2026-10-08T12:00:00.000Z');

DO $$
BEGIN
  BEGIN
    INSERT INTO usage_active_minutes (user_id, minute_start, settled_mask, updated_at)
    VALUES ('schema-user-1', '2026-10-08T12:01:00.000Z', 1152921504606846976, '2026-10-08T12:01:00.000Z');
    RAISE EXCEPTION 'usage_active_minutes accepted mask with bit 60 set';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO telemetry_reports (
      node_id, client_id, window_id, sequence, seconds, timestamp, active_seconds_hex, settlement_status
    ) VALUES (
      'schema-node-1', 'client-1', 'xray-traffic:2026-10-08T12:01Z', 1, 1,
      '2026-10-08T12:01:01.000Z', '1000000000000000', 'settled'
    );
    RAISE EXCEPTION 'telemetry accepted high active-second bits';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO telemetry_reports (
      node_id, client_id, window_id, sequence, seconds, timestamp, active_seconds_hex, settlement_status
    ) VALUES (
      'schema-node-1', 'client-1', 'xray-traffic:2026-10-08T12:01Z', 2, 0,
      '2026-10-08T12:01:01.000Z', '0000000000000000', 'settled'
    );
    RAISE EXCEPTION 'telemetry accepted all-zero active-second bitmap';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO telemetry_reports (
      node_id, client_id, window_id, sequence, seconds, timestamp, active_seconds_hex, settlement_status
    ) VALUES (
      'schema-node-1', 'client-1', 'xray-traffic:2026-10-08T12:01Z', 3, 1,
      '2026-10-08T12:01:01.000Z', '000000000000000A', 'settled'
    );
    RAISE EXCEPTION 'telemetry accepted non-canonical bitmap text';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END $$;
SQL

# Verify an existing 0001 database upgrades without replaying 0001 and receives
# one baseline Premium event at the exact rollout epoch.
base_url="${TEST_DATABASE_URL%/*}"
admin_url="$base_url/postgres"
upgrade_db="madar_upgrade_${RANDOM}_$$"
upgrade_url="$base_url/$upgrade_db"
cleanup_upgrade() {
  psql "$admin_url" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$upgrade_db\" WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup_upgrade EXIT

psql "$admin_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$upgrade_db\"" >/dev/null
psql "$upgrade_url" -v ON_ERROR_STOP=1 -f "$migrations_dir/0001_core.sql" >/dev/null
psql "$upgrade_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO users (id, email, role, verified_at)
VALUES ('upgrade-user-1', 'upgrade@example.com', 'user', '2026-10-08T11:00:00.000Z');
INSERT INTO memberships (user_id, premium_until)
VALUES ('upgrade-user-1', '2026-11-08T11:00:00.000Z');
SQL

if [[ ! -f "$migrations_dir/0002_active_second_accounting.sql" ]]; then
  echo "missing active-second migration: $migrations_dir/0002_active_second_accounting.sql" >&2
  exit 1
fi
psql "$upgrade_url" -v ON_ERROR_STOP=1 -f "$migrations_dir/0002_active_second_accounting.sql" >/dev/null
psql "$upgrade_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
DECLARE
  epoch timestamptz;
  event_count integer;
  event_effective_at timestamptz;
  event_premium_until timestamptz;
BEGIN
  SELECT active_second_epoch INTO epoch FROM usage_accounting_config WHERE id = 1;
  SELECT count(*), min(effective_at), min(premium_until)
    INTO event_count, event_effective_at, event_premium_until
    FROM premium_entitlement_events
    WHERE user_id = 'upgrade-user-1';

  IF epoch IS NULL OR event_count <> 1 OR event_effective_at IS DISTINCT FROM epoch THEN
    RAISE EXCEPTION 'upgrade Premium baseline event does not match accounting epoch';
  END IF;
  IF event_premium_until IS DISTINCT FROM '2026-11-08T11:00:00.000Z'::timestamptz THEN
    RAISE EXCEPTION 'upgrade Premium baseline expiry mismatch';
  END IF;
END $$;
SQL
cleanup_upgrade
trap - EXIT

echo "PostgreSQL schema contract passed"
