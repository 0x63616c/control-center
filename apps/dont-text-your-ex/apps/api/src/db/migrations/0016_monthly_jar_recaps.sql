CREATE TABLE jar_recaps (
  id TEXT PRIMARY KEY,
  jar_id TEXT NOT NULL REFERENCES jars(id) ON DELETE CASCADE,
  calendar_month TEXT NOT NULL CHECK (calendar_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  timezone TEXT NOT NULL,
  period_start_at BIGINT NOT NULL,
  period_end_at BIGINT NOT NULL CHECK (period_end_at > period_start_at),
  slip_count INTEGER NOT NULL CHECK (slip_count >= 0),
  total_amount_cents BIGINT NOT NULL CHECK (total_amount_cents >= 0),
  tally_change_cents BIGINT NOT NULL CHECK (tally_change_cents >= 0),
  shared_streak_highlights JSONB NOT NULL,
  crossed_milestones_cents JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (jar_id, calendar_month)
);

CREATE TABLE jar_recap_recipients (
  recap_id TEXT NOT NULL REFERENCES jar_recaps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eligible_at BIGINT NOT NULL,
  PRIMARY KEY (recap_id, user_id)
);

CREATE INDEX idx_jar_recap_recipient ON jar_recap_recipients(user_id, recap_id);

CREATE FUNCTION reject_jar_recap_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'jar recap snapshots are immutable';
END;
$$;

CREATE TRIGGER jar_recap_immutable
BEFORE UPDATE ON jar_recaps
FOR EACH ROW EXECUTE FUNCTION reject_jar_recap_update();
