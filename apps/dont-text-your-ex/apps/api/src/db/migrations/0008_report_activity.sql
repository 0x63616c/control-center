ALTER TABLE activity
ADD COLUMN IF NOT EXISTS report_id TEXT REFERENCES reports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_activity_report ON activity(report_id);
