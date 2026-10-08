#!/usr/bin/env bash
set -euo pipefail

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"

migration="packages/database/src/migrations/0001_core.sql"
if [[ ! -f "$migration" ]]; then
  echo "missing authoritative PostgreSQL migration: $migration" >&2
  exit 1
fi

psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration" >/dev/null

psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  required_tables text[] := ARRAY[
    'users', 'login_tokens', 'sessions', 'credit_ledger', 'memberships',
    'usage_sessions', 'app_settings', 'nodes', 'plans', 'missions',
    'notification_drafts', 'audit_log', 'access_profiles', 'client_credentials',
    'subscription_tokens', 'node_public_config', 'orders', 'payment_events',
    'mission_submissions', 'mission_rewards', 'push_subscriptions',
    'node_enrollment_tokens', 'node_credentials', 'node_capabilities',
    'node_heartbeats', 'node_policies', 'node_policy_acks',
    'node_user_policy_acks', 'telemetry_reports'
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
BEGIN
  SELECT free_speed_kbps INTO speed FROM app_settings WHERE id = 1;
  IF speed <> 5000 THEN
    RAISE EXCEPTION 'default free speed must be 5000 kbps, got %', speed;
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
SQL

echo "PostgreSQL schema contract passed"
