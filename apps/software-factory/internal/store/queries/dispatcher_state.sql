-- name: DispatcherState :one
SELECT * FROM dispatcher_state WHERE singleton = TRUE;

-- name: PutDispatcherState :exec
UPDATE dispatcher_state
SET config = $1,
    tuning = $2,
    breaker = $3,
    config_error = $4,
    in_flight = $5,
    candidates = $6,
    free_slots = $7,
    written_at = $8
WHERE singleton = TRUE;
