CREATE TABLE user_block (
  blocker_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX idx_user_block_blocked_user
  ON user_block(blocked_user_id, blocker_user_id);

-- Notification producers use INSERT ... RETURNING and only emit their outbox
-- event when a row is returned. Suppress delayed report/activity work at the
-- database boundary so a block remains effective across workflow races.
CREATE FUNCTION dtye_suppress_blocked_pair_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.target_type = 'report' AND EXISTS (
    SELECT 1
    FROM reports report
    JOIN user_block block
      ON (block.blocker_user_id = report.accuser_id
          AND block.blocked_user_id = report.accused_id)
      OR (block.blocker_user_id = report.accused_id
          AND block.blocked_user_id = report.accuser_id)
    WHERE report.id = NEW.target_id
      AND NEW.recipient_user_id IN (report.accuser_id, report.accused_id)
  ) THEN
    RETURN NULL;
  END IF;

  IF NEW.target_type = 'activity' AND EXISTS (
    SELECT 1
    FROM activity event
    JOIN user_block block
      ON (block.blocker_user_id = event.actor_id
          AND block.blocked_user_id = event.target_id)
      OR (block.blocker_user_id = event.target_id
          AND block.blocked_user_id = event.actor_id)
    WHERE event.id = NEW.target_id
      AND NEW.recipient_user_id IN (event.actor_id, event.target_id)
  ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER suppress_blocked_pair_notification_before_insert
BEFORE INSERT ON user_notification
FOR EACH ROW
EXECUTE FUNCTION dtye_suppress_blocked_pair_notification();
