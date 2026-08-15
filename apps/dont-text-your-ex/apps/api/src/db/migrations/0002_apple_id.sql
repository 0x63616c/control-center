-- Sign In with Apple: store the Apple subject id (stable per Apple account).
-- Nullable so existing phone/demo users keep working; unique so one Apple
-- account maps to exactly one user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS apple_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_apple_id ON users (apple_id);
