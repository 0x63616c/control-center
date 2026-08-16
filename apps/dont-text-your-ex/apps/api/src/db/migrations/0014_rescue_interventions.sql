CREATE TABLE rescue_interventions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('active','check_in_due','safe','slipped','abandoned')),
  started_at BIGINT NOT NULL,
  deadline_at BIGINT NOT NULL,
  extension_count INTEGER NOT NULL DEFAULT 0 CHECK (extension_count BETWEEN 0 AND 2),
  aggregate_version BIGINT NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  check_in_due_at BIGINT,
  response_deadline_at BIGINT,
  resolved_at BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX idx_rescue_interventions_one_live_per_user
  ON rescue_interventions(user_id)
  WHERE state IN ('active','check_in_due');

CREATE INDEX idx_rescue_interventions_user_started
  ON rescue_interventions(user_id,started_at DESC,id DESC);
