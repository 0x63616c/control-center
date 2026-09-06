-- Avatar emoji are a closed product choice, not a free-text UGC channel.
-- Clear any legacy value outside the current picker before enforcing the
-- invariant at the persistence boundary.
UPDATE users
SET emoji = NULL
WHERE emoji IS NOT NULL
  AND emoji NOT IN ('🫠','💔','🥲','😈','🦝','🍷','👀');

ALTER TABLE users
  ADD CONSTRAINT users_avatar_emoji_allowlist
  CHECK (emoji IS NULL OR emoji IN ('🫠','💔','🥲','😈','🦝','🍷','👀'));
