-- name: TicketForTargetClaim :one
SELECT * FROM ticket WHERE id = $1 FOR UPDATE;

-- name: InsertTargetRun :one
INSERT INTO run (id, ticket_id, started_at)
VALUES ($1, $2, $3)
ON CONFLICT (id) DO UPDATE SET id = run.id
RETURNING *;

-- name: ActivateTargetTicket :one
UPDATE ticket SET state = 'active', active_run_id = $2, updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND state = 'open'
RETURNING *;

-- name: TargetRunForUpdate :one
SELECT * FROM run WHERE id = $1 FOR UPDATE;

-- name: TargetTicketForUpdate :one
SELECT * FROM ticket WHERE id = $1 FOR UPDATE;

-- name: StartTargetStep :one
INSERT INTO run_step (run_id, ordinal, kind, iteration, reason, state, started_at)
VALUES ($1, $2, $3, $4, $5, 'running', $6)
ON CONFLICT (run_id, ordinal) DO UPDATE SET run_id = run_step.run_id
RETURNING *;

-- name: CompleteTargetStep :one
UPDATE run_step SET state = 'completed', ended_at = $3, result = $4
WHERE run_id = $1 AND ordinal = $2
  AND (state = 'running' OR (state = 'completed' AND result = $4))
RETURNING *;

-- name: TargetStepForRun :many
SELECT * FROM run_step WHERE run_id = $1 ORDER BY ordinal;

-- name: StartTargetAgentAttempt :one
INSERT INTO run_agent_attempt (
    run_id, step_ordinal, attempt_no, agent_stage, model, effort, state,
    usage_state, started_at
) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8)
ON CONFLICT (run_id, step_ordinal, attempt_no) DO UPDATE SET run_id = run_agent_attempt.run_id
RETURNING *;

-- name: TargetAgentAttemptsForRun :many
SELECT * FROM run_agent_attempt WHERE run_id = $1 ORDER BY step_ordinal, attempt_no;

-- name: TargetAgentAttemptForUpdate :one
SELECT * FROM run_agent_attempt
WHERE run_id = $1 AND step_ordinal = $2 AND attempt_no = $3 FOR UPDATE;

-- name: CheckpointTargetAgentAttempt :one
UPDATE run_agent_attempt SET
    provider_thread_id = $4,
    state = $5,
    failure_kind = $6,
    usage_state = $7,
    input_tokens = $8,
    cached_input_tokens = $9,
    output_tokens = $10,
    reasoning_tokens = $11,
    ended_at = $12,
    result = $13
WHERE run_id = $1 AND step_ordinal = $2 AND attempt_no = $3
RETURNING *;

-- name: PutTargetAgentTranscript :exec
INSERT INTO run_agent_transcript (
    run_id, step_ordinal, attempt_no, compressed_bytes, compression,
    uncompressed_size_bytes, checksum
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (run_id, step_ordinal, attempt_no) DO NOTHING;

-- name: TargetTranscriptKeysForRun :many
SELECT run_id, step_ordinal, attempt_no FROM run_agent_transcript
WHERE run_id = $1 ORDER BY step_ordinal, attempt_no;

-- name: TargetAgentTranscript :one
SELECT * FROM run_agent_transcript
WHERE run_id = $1 AND step_ordinal = $2 AND attempt_no = $3;

-- name: BindTargetAttemptCapability :one
UPDATE run_agent_attempt SET checkpoint_capability_hash = $4
WHERE run_id = $1 AND step_ordinal = $2 AND attempt_no = $3 AND state = 'running'
RETURNING *;

-- name: TargetGitCheckpoint :one
SELECT * FROM run_git_checkpoint WHERE run_id = $1;

-- name: PutTargetGitCheckpoint :one
INSERT INTO run_git_checkpoint (
    run_id, step_ordinal, branch, pushed_head, observed_base,
    pull_request_number, pull_request_node_id, step_result
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (run_id) DO UPDATE SET
    step_ordinal = EXCLUDED.step_ordinal,
    branch = EXCLUDED.branch,
    pushed_head = EXCLUDED.pushed_head,
    observed_base = EXCLUDED.observed_base,
    pull_request_number = EXCLUDED.pull_request_number,
    pull_request_node_id = EXCLUDED.pull_request_node_id,
    step_result = EXCLUDED.step_result
WHERE run_git_checkpoint.step_ordinal <= EXCLUDED.step_ordinal
RETURNING *;

-- name: CompleteTargetRunSuccess :one
UPDATE run SET target_outcome = 'succeeded', target_failure_kind = '',
    reviewed_head = $2, merge_sha = $3, ended_at = $4
WHERE id = $1 AND target_outcome IS NULL
RETURNING *;

-- name: ReconcileCanceledTargetRunSuccess :one
UPDATE run SET target_outcome = 'succeeded', target_failure_kind = '',
    reviewed_head = $2, merge_sha = $3, ended_at = $4
WHERE id = $1 AND target_outcome = 'canceled'
RETURNING *;

-- name: CompleteTargetRunCanceled :one
UPDATE run SET target_outcome = 'canceled', target_failure_kind = '', ended_at = $2
WHERE id = $1 AND target_outcome IS NULL
RETURNING *;

-- name: CompleteTargetTicket :one
UPDATE ticket SET state = 'done', active_run_id = NULL, updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND state = 'active' AND active_run_id = $2
RETURNING *;

-- name: CompleteCanceledTargetTicket :one
UPDATE ticket SET state = 'done', active_run_id = NULL, updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND state = 'open' AND active_run_id IS NULL
RETURNING *;

-- name: ReopenTargetTicket :one
UPDATE ticket SET state = 'open', active_run_id = NULL, updated_at = CURRENT_TIMESTAMP
WHERE id = $1 AND state = 'active' AND active_run_id = $2
RETURNING *;
