CREATE TABLE abuse_report (
  id TEXT PRIMARY KEY CHECK (id ~ '^abr_[a-f0-9]{32}$'),
  -- P01 chose immediate erasure with no legal-retention exception. A report is
  -- linked personal data for both participants, so either account deletion
  -- erases the report, encrypted narrative, references, and audit together.
  reporter_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  narrative_ciphertext TEXT,
  narrative_nonce TEXT,
  narrative_key_version TEXT,
  -- Keep validated reference identifiers as immutable moderation context even
  -- after gameplay/account data is erased. Foreign keys with ON DELETE SET
  -- NULL would either destroy the only context for reference-only reports or
  -- violate the content-presence CHECK below during account deletion.
  referenced_jar_id TEXT,
  referenced_gameplay_report_id TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','reviewing','resolved','dismissed')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (
    (narrative_ciphertext IS NULL AND narrative_nonce IS NULL AND narrative_key_version IS NULL)
    OR
    (narrative_ciphertext IS NOT NULL AND narrative_nonce IS NOT NULL AND narrative_key_version IS NOT NULL)
  ),
  CHECK (
    narrative_ciphertext IS NOT NULL
    OR referenced_jar_id IS NOT NULL
    OR referenced_gameplay_report_id IS NOT NULL
  )
);

CREATE INDEX idx_abuse_report_status_created ON abuse_report(status, created_at, id);

CREATE TABLE abuse_report_audit_event (
  id TEXT PRIMARY KEY CHECK (id ~ '^mae_[a-f0-9]{32}$'),
  abuse_report_id TEXT NOT NULL REFERENCES abuse_report(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('submitted','reviewing','resolved','dismissed')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX idx_abuse_report_audit_event_report
  ON abuse_report_audit_event(abuse_report_id, created_at, id);

CREATE FUNCTION reject_abuse_report_audit_mutation() RETURNS trigger AS $$
BEGIN
  -- The only permitted DELETE is the FK cascade after its parent report has
  -- already been erased for account deletion.
  IF TG_OP = 'DELETE'
    AND NOT EXISTS (SELECT 1 FROM abuse_report WHERE id = OLD.abuse_report_id)
  THEN
    RETURN OLD;
  END IF;
  -- Account deletion must erase the reporter's identifier. PostgreSQL's
  -- ON DELETE SET NULL action is an UPDATE, so admit only that narrowly
  -- constrained privacy redaction after the referenced user has disappeared.
  IF OLD.actor_user_id IS NOT NULL
    AND NEW.actor_user_id IS NULL
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.abuse_report_id IS NOT DISTINCT FROM OLD.abuse_report_id
    AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
    AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD.actor_user_id)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'abuse report audit events are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER abuse_report_audit_event_immutable
BEFORE UPDATE OR DELETE ON abuse_report_audit_event
FOR EACH ROW EXECUTE FUNCTION reject_abuse_report_audit_mutation();
