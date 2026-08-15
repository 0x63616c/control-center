-- Streak sharing is opt-in. Existing true values cannot be distinguished from
-- the old implicit default, so reset them rather than infer consent.
UPDATE memberships SET share_streak = 0 WHERE share_streak <> 0;
ALTER TABLE memberships ALTER COLUMN share_streak SET DEFAULT 0;
