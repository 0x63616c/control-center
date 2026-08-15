ALTER TABLE memberships ADD COLUMN IF NOT EXISTS left_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_membership_active_user ON memberships(user_id, left_at);
