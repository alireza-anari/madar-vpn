#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"

umask 077
workdir="$(mktemp -d)"
backup="$workdir/madar-test.dump"
trap 'rm -rf "$workdir"' EXIT

# The schema contract runs before this test and seeds deterministic witness rows.
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT CASE WHEN EXISTS (SELECT 1 FROM users WHERE id = 'schema-user-1') THEN 'ok' ELSE 'missing' END" \
  | grep -qx 'ok'
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT COALESCE(SUM(delta_seconds), 0) FROM credit_ledger WHERE user_id = 'schema-user-1'" \
  | grep -qx '1800'
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT COALESCE(SUM(delta_seconds), 0) FROM credit_ledger WHERE user_id = 'schema-usage-user-1'" \
  | grep -qx -- '-2'
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT settled_mask FROM usage_active_minutes WHERE user_id = 'schema-usage-user-1' AND minute_start = '2026-10-08T12:02:00.000Z'" \
  | grep -qx '3'
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT observed_mask || ':' || new_mask || ':' || debited_mask || ':' || debit_seconds FROM usage_debit_events WHERE node_id = 'schema-node-1' AND window_id = 'xray-traffic:2026-10-08T12:02Z' AND sequence = 10" \
  | grep -qx '3:3:3:2'

# Backup tooling must match the PostgreSQL server major version. The CI service
# is PostgreSQL 17, so use that pinned client image rather than the runner's
# distro client, which may lag behind and refuse to dump a newer server.
docker run --rm --network host postgres:17 \
  pg_dump \
    --format=custom \
    --no-owner \
    --no-acl \
    "$TEST_DATABASE_URL" > "$backup"

[[ -s "$backup" ]]
mode="$(stat -c '%a' "$backup")"
if [[ "$mode" != "600" ]]; then
  echo "backup file permissions are not restrictive" >&2
  exit 1
fi

# This database exists only for CI. Destructively remove public state so restore is real.
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
SQL

missing_after_wipe="$(psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -Atc "SELECT to_regclass('public.users') IS NULL")"
[[ "$missing_after_wipe" == "t" ]]

docker run --rm --network host -i postgres:17 \
  pg_restore \
    --exit-on-error \
    --no-owner \
    --no-acl \
    --dbname="$TEST_DATABASE_URL" < "$backup" >/dev/null

psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
DECLARE
  restored_email text;
  restored_credit bigint;
  restored_usage_credit bigint;
  restored_speed integer;
  restored_mask bigint;
  restored_observed bigint;
  restored_new bigint;
  restored_debited bigint;
  restored_seconds integer;
  restored_bitmap text;
  restored_status text;
BEGIN
  SELECT email INTO restored_email FROM users WHERE id = 'schema-user-1';
  IF restored_email <> 'User@Example.COM' THEN
    RAISE EXCEPTION 'restored user witness mismatch';
  END IF;

  SELECT COALESCE(SUM(delta_seconds), 0)
    INTO restored_credit
    FROM credit_ledger
    WHERE user_id = 'schema-user-1';
  IF restored_credit <> 1800 THEN
    RAISE EXCEPTION 'restored ledger witness mismatch';
  END IF;

  SELECT COALESCE(SUM(delta_seconds), 0)
    INTO restored_usage_credit
    FROM credit_ledger
    WHERE user_id = 'schema-usage-user-1';
  IF restored_usage_credit <> -2 THEN
    RAISE EXCEPTION 'restored usage ledger witness mismatch';
  END IF;

  SELECT free_speed_kbps INTO restored_speed FROM app_settings WHERE id = 1;
  IF restored_speed <> 5000 THEN
    RAISE EXCEPTION 'restored settings witness mismatch';
  END IF;

  SELECT settled_mask
    INTO restored_mask
    FROM usage_active_minutes
    WHERE user_id = 'schema-usage-user-1'
      AND minute_start = '2026-10-08T12:02:00.000Z';
  IF restored_mask IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'restored active-minute mask mismatch';
  END IF;

  SELECT observed_mask, new_mask, debited_mask, debit_seconds
    INTO restored_observed, restored_new, restored_debited, restored_seconds
    FROM usage_debit_events
    WHERE node_id = 'schema-node-1'
      AND window_id = 'xray-traffic:2026-10-08T12:02Z'
      AND sequence = 10;
  IF restored_observed IS DISTINCT FROM 3
     OR restored_new IS DISTINCT FROM 3
     OR restored_debited IS DISTINCT FROM 3
     OR restored_seconds IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'restored usage debit evidence mismatch';
  END IF;

  SELECT active_seconds_hex, settlement_status
    INTO restored_bitmap, restored_status
    FROM telemetry_reports
    WHERE node_id = 'schema-node-1'
      AND window_id = 'xray-traffic:2026-10-08T12:02Z'
      AND sequence = 10;
  IF restored_bitmap IS DISTINCT FROM '0000000000000003'
     OR restored_status IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'restored raw telemetry bitmap mismatch';
  END IF;
END $$;
SQL

echo "PostgreSQL backup/restore contract passed"
