CREATE TABLE domain_event (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version BIGINT NOT NULL CHECK (aggregate_version > 0),
  occurred_at BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'dispatched', 'failed')),
  available_at BIGINT NOT NULL,
  claim_owner TEXT,
  claim_expires_at BIGINT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at BIGINT,
  last_error_code TEXT,
  dispatched_at BIGINT,
  failed_at BIGINT,
  UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type)
);

CREATE INDEX idx_domain_event_dispatch
  ON domain_event(state, available_at, occurred_at, id);
CREATE INDEX idx_domain_event_aggregate
  ON domain_event(aggregate_type, aggregate_id, aggregate_version, occurred_at);

ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';
ALTER TABLE jars ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles';
ALTER TABLE jars ADD COLUMN invite_version_id TEXT;
UPDATE jars
SET invite_version_id = 'inv_' || md5(id || ':' || COALESCE(invite_code, '') || ':' || created_at::TEXT)
WHERE invite_version_id IS NULL;
ALTER TABLE jars ALTER COLUMN invite_version_id SET NOT NULL;
CREATE UNIQUE INDEX idx_jars_invite_version ON jars(invite_version_id);

CREATE TABLE membership_tenures (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  joined_at BIGINT NOT NULL,
  left_at BIGINT
);
INSERT INTO membership_tenures (id, membership_id, joined_at, left_at)
SELECT 'mtn_' || md5(id || ':' || joined_at::TEXT), id, joined_at, left_at
FROM memberships;
CREATE UNIQUE INDEX idx_membership_tenures_open
  ON membership_tenures(membership_id) WHERE left_at IS NULL;
CREATE INDEX idx_membership_tenures_interval
  ON membership_tenures(membership_id, joined_at, left_at);

CREATE TABLE jar_milestones (
  id TEXT PRIMARY KEY,
  jar_id TEXT NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  threshold_cents INTEGER NOT NULL CHECK (threshold_cents > 0),
  reached_at BIGINT NOT NULL,
  UNIQUE (jar_id, threshold_cents)
);

CREATE INDEX idx_sessions_expiry ON sessions(expires_at, token);
