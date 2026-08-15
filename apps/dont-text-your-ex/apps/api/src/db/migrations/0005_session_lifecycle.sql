ALTER TABLE sessions ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at BIGINT;

-- Preserve existing sessions only within the same absolute lifetime applied to
-- new authentication. Older sessions become expired on their next lookup.
UPDATE sessions
SET expires_at = created_at + 2592000000,
    last_used_at = created_at
WHERE expires_at IS NULL OR last_used_at IS NULL;

ALTER TABLE sessions ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN last_used_at SET NOT NULL;
