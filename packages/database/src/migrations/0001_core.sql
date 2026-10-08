BEGIN;

CREATE TABLE users (
  id text PRIMARY KEY,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'admin')),
  verified_at timestamptz NOT NULL,
  suspended_at timestamptz
);

CREATE UNIQUE INDEX users_email_canonical_unique ON users (lower(email));
CREATE INDEX users_suspended_at_idx ON users (suspended_at);

CREATE TABLE login_tokens (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX login_tokens_email_idx ON login_tokens (lower(email));

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_token_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE credit_ledger (
  unique_key text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('initial', 'ad', 'usage', 'manual', 'mission')),
  free_day date NOT NULL,
  delta_seconds integer NOT NULL,
  occurred_at timestamptz NOT NULL,
  node_id text,
  session_id text,
  sequence integer
);

CREATE INDEX credit_ledger_user_day_idx ON credit_ledger (user_id, free_day);

CREATE TABLE memberships (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  premium_until timestamptz
);

CREATE TABLE usage_sessions (
  node_id text NOT NULL,
  session_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (node_id, session_id)
);

CREATE INDEX usage_sessions_user_id_idx ON usage_sessions (user_id);

CREATE TABLE premium_adjustments (
  unique_key text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  premium_until timestamptz,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX premium_adjustments_user_id_idx ON premium_adjustments (user_id);

CREATE TABLE app_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  free_speed_kbps integer NOT NULL CHECK (free_speed_kbps BETWEEN 64 AND 1000000),
  notifications_enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL
);

INSERT INTO app_settings (id, free_speed_kbps, notifications_enabled, updated_at)
VALUES (1, 5000, false, '1970-01-01T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE nodes (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('enrolled', 'ready', 'offline', 'error')),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE INDEX nodes_status_idx ON nodes (status);

CREATE TABLE plans (
  id text PRIMARY KEY,
  title text NOT NULL,
  duration_days integer NOT NULL CHECK (duration_days > 0),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE missions (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  reward_seconds integer NOT NULL CHECK (reward_seconds >= 0),
  status text NOT NULL CHECK (status IN ('draft', 'active', 'paused')),
  verification_kind text NOT NULL DEFAULT 'evidence' CHECK (verification_kind IN ('evidence', 'referral')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE notification_drafts (
  id text PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  target text NOT NULL,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL
);

CREATE TABLE audit_log (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  details_json jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX audit_log_created_at_idx ON audit_log (created_at DESC);

CREATE TABLE access_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  policy_revision integer NOT NULL DEFAULT 1 CHECK (policy_revision >= 1),
  created_at timestamptz NOT NULL
);

CREATE TABLE client_credentials (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uuid text NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (user_id, version)
);

CREATE UNIQUE INDEX client_credentials_one_active_idx
  ON client_credentials (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE subscription_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  version integer NOT NULL CHECK (version >= 1),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (user_id, version)
);

CREATE UNIQUE INDEX subscription_tokens_one_active_idx
  ON subscription_tokens (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE node_public_configs (
  node_id text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  address text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  server_name text NOT NULL,
  reality_public_key text NOT NULL,
  reality_short_id text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE node_policy_acks (
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  acked_at timestamptz NOT NULL,
  PRIMARY KEY (node_id, user_id)
);

CREATE INDEX node_policy_acks_user_revision_idx ON node_policy_acks (user_id, revision);

CREATE TABLE orders (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id text NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  duration_days integer NOT NULL CHECK (duration_days > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'settled')),
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  CHECK (
    (status = 'pending' AND settled_at IS NULL) OR
    (status = 'settled' AND settled_at IS NOT NULL)
  )
);

CREATE TABLE payment_events (
  source_key text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX orders_user_created_at_idx ON orders (user_id, created_at DESC);
CREATE INDEX payment_events_order_id_idx ON payment_events (order_id);

CREATE TABLE mission_submissions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id text NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  evidence_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  reviewed_by text REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason text
);

CREATE INDEX mission_submissions_user_idx ON mission_submissions (user_id, submitted_at DESC);
CREATE INDEX mission_submissions_status_idx ON mission_submissions (status, submitted_at ASC);

CREATE TABLE verified_referrals (
  referrer_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at timestamptz NOT NULL,
  evidence_json jsonb,
  PRIMARY KEY (referrer_user_id, referred_user_id),
  CHECK (referrer_user_id <> referred_user_id)
);

CREATE TABLE push_subscriptions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  expiration_time bigint,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id, updated_at DESC);

CREATE TABLE node_enrollment_tokens (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE INDEX node_enrollment_tokens_expiry_idx
  ON node_enrollment_tokens (expires_at)
  WHERE used_at IS NULL;

CREATE TABLE node_credentials (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  credential_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE UNIQUE INDEX node_credentials_one_active_idx
  ON node_credentials (node_id)
  WHERE revoked_at IS NULL;

CREATE TABLE node_capabilities (
  node_id text PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  capabilities_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE node_health_samples (
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL,
  health_json jsonb NOT NULL,
  versions_json jsonb NOT NULL,
  capacity_json jsonb NOT NULL,
  PRIMARY KEY (node_id, recorded_at)
);

CREATE INDEX node_health_samples_latest_idx ON node_health_samples (node_id, recorded_at DESC);

CREATE TABLE node_policy_revisions (
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  valid_until timestamptz NOT NULL,
  policy_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  acked_at timestamptz,
  PRIMARY KEY (node_id, revision)
);

CREATE INDEX node_policy_revisions_latest_idx ON node_policy_revisions (node_id, revision DESC);

CREATE TABLE telemetry_reports (
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  window_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 0),
  seconds integer NOT NULL CHECK (seconds >= 0),
  timestamp timestamptz NOT NULL,
  observed_from timestamptz,
  observed_to timestamptz,
  session_id text,
  PRIMARY KEY (node_id, window_id, sequence)
);

CREATE INDEX telemetry_reports_client_time_idx ON telemetry_reports (client_id, timestamp);

COMMIT;
