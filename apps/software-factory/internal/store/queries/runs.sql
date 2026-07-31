-- name: StartRun :one
-- Idempotent: a retried call starting the same run id again overwrites the
-- row with the same values (an activity retry always carries what the first
-- attempt did) rather than violating the primary key.
INSERT INTO run (id, ticket_id, started_at)
VALUES ($1, $2, $3)
ON CONFLICT (id) DO UPDATE SET
    ticket_id = EXCLUDED.ticket_id,
    started_at = EXCLUDED.started_at
RETURNING *;

-- name: EndRun :one
UPDATE run SET ended_at = $2, outcome = $3, failure_kind = $4
WHERE id = $1
RETURNING *;

-- name: Run :one
SELECT * FROM run WHERE id = $1;

-- name: RunsForTicket :many
-- Most recent first: the console's ticket detail view leads with the
-- current or latest Run.
SELECT * FROM run WHERE ticket_id = $1 ORDER BY started_at DESC;
