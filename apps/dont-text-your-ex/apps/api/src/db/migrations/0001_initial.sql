-- Text Your Ex: initial schema (Postgres port of the SQLite prototype).
-- All timestamps are millisecond epoch integers (BIGINT) to match the JS layer.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#5E5CE6',
  emoji TEXT,
  photo TEXT,
  phone TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'demo',
  notif_prefs TEXT NOT NULL DEFAULT '{"slips":true,"reports":true,"joins":true,"milestones":true}',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_exes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rule TEXT NOT NULL DEFAULT '',
  default_cents INTEGER NOT NULL DEFAULT 500,
  currency TEXT NOT NULL DEFAULT 'usd',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  jar_id TEXT NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  tally_cents INTEGER NOT NULL DEFAULT 0,
  streak_start_at BIGINT,
  share_streak INTEGER NOT NULL DEFAULT 1,
  joined_at BIGINT NOT NULL,
  UNIQUE (jar_id, user_id)
);

CREATE TABLE IF NOT EXISTS slips (
  id TEXT PRIMARY KEY,
  jar_id TEXT NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  note TEXT,
  ex_label TEXT,
  source TEXT NOT NULL DEFAULT 'self',
  reported_by TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  jar_id TEXT NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  accuser_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accused_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT,
  is_anonymous INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 500,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);

CREATE TABLE IF NOT EXISTS report_evidence (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'image',
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  jar_id TEXT NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  actor_id TEXT,
  target_id TEXT,
  type TEXT NOT NULL,
  text TEXT,
  amount_cents INTEGER,
  ex_label TEXT,
  note TEXT,
  anonymous INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);

-- Pretend OTP store (phone -> code); the "check your texts" flow is demo-only.
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_membership_jar ON memberships(jar_id);
CREATE INDEX IF NOT EXISTS idx_membership_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_jar ON activity(jar_id, created_at);
CREATE INDEX IF NOT EXISTS idx_slip_jar ON slips(jar_id, created_at);
CREATE INDEX IF NOT EXISTS idx_report_accused ON reports(accused_id, status);
