ALTER TABLE missions
ADD COLUMN verification_kind TEXT NOT NULL DEFAULT 'evidence'
CHECK (verification_kind IN ('evidence', 'referral'));

CREATE TABLE mission_submissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason TEXT
);

CREATE INDEX idx_mission_submissions_user
  ON mission_submissions(user_id, submitted_at DESC);

CREATE INDEX idx_mission_submissions_status
  ON mission_submissions(status, submitted_at ASC);

CREATE TABLE verified_referrals (
  referrer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TEXT NOT NULL,
  evidence_json TEXT,
  PRIMARY KEY (referrer_user_id, referred_user_id),
  CHECK (referrer_user_id <> referred_user_id)
);

CREATE TABLE credit_ledger_v3 (
  unique_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'ad', 'usage', 'manual', 'mission')),
  free_day TEXT NOT NULL,
  delta_seconds INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  node_id TEXT,
  session_id TEXT,
  sequence INTEGER
);

INSERT INTO credit_ledger_v3 (
  unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
  node_id, session_id, sequence
)
SELECT
  unique_key, user_id, kind, free_day, delta_seconds, occurred_at,
  node_id, session_id, sequence
FROM credit_ledger;

DROP TABLE credit_ledger;
ALTER TABLE credit_ledger_v3 RENAME TO credit_ledger;

CREATE INDEX idx_credit_ledger_user_day
  ON credit_ledger(user_id, free_day);
