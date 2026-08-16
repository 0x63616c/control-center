ALTER TABLE reports
  ADD COLUMN aggregate_version BIGINT NOT NULL DEFAULT 1;

ALTER TABLE reports
  ADD COLUMN resolution_reason TEXT,
  ADD CONSTRAINT reports_resolution_reason_check
  CHECK (resolution_reason IS NULL OR resolution_reason IN ('timeout','account_deleted'));

ALTER TABLE reports
  ADD CONSTRAINT reports_status_check
  CHECK (status IN ('pending','owned','denied','expired'));

CREATE INDEX idx_reports_pending_created
  ON reports(created_at, id) WHERE status = 'pending';

-- Existing pending reports enter the same durable dispatcher as new reports.
-- Their original timestamp lets the workflow skip already-past reminder stages.
INSERT INTO domain_event
  (id, event_type, schema_version, aggregate_type, aggregate_id,
   aggregate_version, occurred_at, available_at)
SELECT
  'evt_' || replace(gen_random_uuid()::text, '-', ''),
  'report.created', 1, 'report', id, aggregate_version, created_at,
  (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT
FROM reports
WHERE status = 'pending'
ON CONFLICT (aggregate_type, aggregate_id, aggregate_version, event_type) DO NOTHING;
