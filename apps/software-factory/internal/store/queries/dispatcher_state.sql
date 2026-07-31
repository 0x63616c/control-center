-- name: DispatcherState :one
SELECT * FROM dispatcher_state WHERE singleton = TRUE;

-- name: PutDispatcherState :exec
UPDATE dispatcher_state
SET paused = $1,
    max_in_flight = $2,
    breaker_open_until = $3,
    breaker_reason = $4,
    in_flight = $5,
    next_ticket_id = $6,
    written_at = $7
WHERE singleton = TRUE;
