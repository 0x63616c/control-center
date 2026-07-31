-- name: RecordAttempt :one
INSERT INTO attempt (
    run_id, stage, turn, attempt_no,
    model, effort,
    input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
    measured, started_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: EndAttempt :one
UPDATE attempt SET ended_at = $5, result = $6
WHERE run_id = $1 AND stage = $2 AND turn = $3 AND attempt_no = $4
RETURNING *;

-- name: AttemptsForStep :many
SELECT * FROM attempt WHERE run_id = $1 AND stage = $2 AND turn = $3 ORDER BY attempt_no;

-- name: AttemptsForRun :many
SELECT * FROM attempt WHERE run_id = $1 ORDER BY stage, turn, attempt_no;
