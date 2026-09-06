ALTER TABLE users
  ADD COLUMN deletion_requested_at BIGINT;

ALTER TABLE jars DROP CONSTRAINT jars_created_by_fkey;
ALTER TABLE jars ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE jars
  ADD CONSTRAINT jars_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE jars DROP CONSTRAINT jars_closed_by_fkey;
ALTER TABLE jars
  ADD CONSTRAINT jars_closed_by_fkey
  FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE account_deletion_request (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN (
    'accepted', 'erasing', 'locally_erased', 'apple_revocation_pending',
    'complete', 'manual_action_required'
  )),
  aggregate_version BIGINT NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  authorization_code_ciphertext TEXT,
  authorization_code_nonce TEXT,
  authorization_code_key_id TEXT,
  apple_subject_ciphertext TEXT,
  apple_subject_nonce TEXT,
  apple_subject_key_id TEXT,
  refresh_token_ciphertext TEXT,
  refresh_token_nonce TEXT,
  refresh_token_key_id TEXT,
  revocation_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (revocation_attempt_count >= 0),
  last_error_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  locally_erased_at BIGINT,
  terminal_at BIGINT,
  CHECK ((authorization_code_ciphertext IS NULL) = (authorization_code_nonce IS NULL)),
  CHECK ((authorization_code_ciphertext IS NULL) = (authorization_code_key_id IS NULL)),
  CHECK ((apple_subject_ciphertext IS NULL) = (apple_subject_nonce IS NULL)),
  CHECK ((apple_subject_ciphertext IS NULL) = (apple_subject_key_id IS NULL)),
  CHECK ((authorization_code_ciphertext IS NULL) = (apple_subject_ciphertext IS NULL)),
  CHECK ((refresh_token_ciphertext IS NULL) = (refresh_token_nonce IS NULL)),
  CHECK ((refresh_token_ciphertext IS NULL) = (refresh_token_key_id IS NULL))
);

CREATE UNIQUE INDEX account_deletion_request_one_live_user
  ON account_deletion_request(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX account_deletion_request_state
  ON account_deletion_request(state, updated_at, id);

CREATE TABLE account_deletion_cleanup_item (
  deletion_request_id TEXT NOT NULL REFERENCES account_deletion_request(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'terminated', 'deleted')),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (deletion_request_id, workflow_id)
);

CREATE TABLE deletion_restore_tombstone (
  deletion_request_id TEXT PRIMARY KEY REFERENCES account_deletion_request(id) ON DELETE CASCADE,
  user_hmac TEXT NOT NULL,
  key_version TEXT NOT NULL,
  signature TEXT NOT NULL,
  signature_key_version TEXT NOT NULL,
  journal_published_at BIGINT NOT NULL,
  completed_at BIGINT,
  expires_at BIGINT NOT NULL
);
