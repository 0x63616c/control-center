ALTER TABLE abuse_report_audit_event
  ADD COLUMN actor_identity TEXT;

ALTER TABLE abuse_report_audit_event
  ADD CONSTRAINT abuse_report_audit_actor_identity
  CHECK (
    (event_type = 'submitted' AND actor_identity IS NULL)
    OR
    (
      event_type IN ('reviewing','resolved','dismissed')
      AND actor_user_id IS NULL
      AND actor_identity ~ '^operator:[a-z0-9]+(-[a-z0-9]+)*$'
    )
  );

CREATE OR REPLACE FUNCTION reject_abuse_report_audit_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND NOT EXISTS (SELECT 1 FROM abuse_report WHERE id = OLD.abuse_report_id)
  THEN
    RETURN OLD;
  END IF;
  -- Preserve the audit record while allowing the foreign-key action used by
  -- account deletion to remove its last user identifier. No operator identity
  -- or substantive audit field may change as part of this exception.
  IF OLD.actor_user_id IS NOT NULL
    AND NEW.actor_user_id IS NULL
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.abuse_report_id IS NOT DISTINCT FROM OLD.abuse_report_id
    AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
    AND NEW.actor_identity IS NOT DISTINCT FROM OLD.actor_identity
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.actor_user_id)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'abuse report audit events are immutable';
END;
$$ LANGUAGE plpgsql;
