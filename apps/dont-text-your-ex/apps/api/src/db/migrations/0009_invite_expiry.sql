-- Invite codes are absolute seven-day capabilities. Existing open codes receive
-- a fresh seven-day window at rollout so the migration does not break links in flight.
ALTER TABLE jars ADD COLUMN IF NOT EXISTS invite_expires_at BIGINT;

UPDATE jars
SET invite_expires_at = (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT + 604800000
WHERE invite_code IS NOT NULL AND invite_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_jars_invite_expiry
  ON jars(invite_code, invite_expires_at)
  WHERE invite_code IS NOT NULL;
