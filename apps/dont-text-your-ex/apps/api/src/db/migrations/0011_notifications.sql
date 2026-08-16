CREATE TABLE IF NOT EXISTS notification_preference (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('report','rescue','slip','join','jar_milestone','streak_milestone','recap','invite')),
  enabled BOOLEAN NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS push_device (
  installation_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform = 'ios'),
  environment TEXT NOT NULL CHECK (environment IN ('production','sandbox')),
  token_ciphertext TEXT NOT NULL,
  token_nonce TEXT NOT NULL,
  token_key_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  app_version TEXT NOT NULL,
  app_build TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_registered_at BIGINT NOT NULL,
  last_success_at BIGINT,
  last_failure_code TEXT,
  disabled_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_push_device_user_active
  ON push_device(user_id, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_device_active_token
  ON push_device(token_sha256) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_push_device_key
  ON push_device(token_key_id);

CREATE TABLE IF NOT EXISTS user_notification (
  id TEXT PRIMARY KEY,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('report','rescue','slip','join','jar_milestone','streak_milestone','recap','invite','account_deletion')),
  dedupe_key TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('activity','report','jar','profile')),
  target_id TEXT,
  message_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  cancelled_at BIGINT,
  UNIQUE (recipient_user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_recipient
  ON user_notification(recipient_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_delivery (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES user_notification(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL REFERENCES push_device(installation_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','invalid_device','permanent_failure','suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  apns_id TEXT,
  failure_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (notification_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_status
  ON notification_delivery(status, updated_at);
