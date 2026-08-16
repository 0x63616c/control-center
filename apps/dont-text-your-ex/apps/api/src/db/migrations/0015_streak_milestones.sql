-- Existing releases did not collect a device timezone, so preserve their
-- established behavior with one explicit fallback before enforcing IANA names.
UPDATE users
SET timezone = 'America/Los_Angeles'
WHERE timezone IS NULL
   OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = users.timezone)
   OR (timezone <> 'UTC' AND POSITION('/' IN timezone) = 0);

CREATE OR REPLACE FUNCTION validate_user_iana_timezone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.timezone <> 'UTC' AND POSITION('/' IN NEW.timezone) = 0)
     OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'invalid IANA timezone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_iana_timezone ON users;
CREATE TRIGGER users_iana_timezone
BEFORE INSERT OR UPDATE OF timezone ON users
FOR EACH ROW EXECUTE FUNCTION validate_user_iana_timezone();

CREATE TABLE streak_achievements (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  streak_started_at BIGINT NOT NULL,
  milestone_days INTEGER NOT NULL CHECK (milestone_days IN (7, 30, 100, 365)),
  reached_local_date DATE NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (membership_id, streak_started_at, milestone_days, reached_local_date),
  -- A timezone change can alter the derived local date but cannot award the
  -- same streak instance and milestone twice.
  UNIQUE (membership_id, streak_started_at, milestone_days)
);

CREATE INDEX idx_streak_achievements_membership
  ON streak_achievements(membership_id, streak_started_at, milestone_days);
