-- name: StartRun :one
INSERT INTO run (id, ticket_id, started_at)
VALUES ($1, $2, $3)
RETURNING *;

-- name: EndRun :one
UPDATE run SET ended_at = $2, outcome = $3, failure_kind = $4
WHERE id = $1
RETURNING *;

-- name: Run :one
SELECT * FROM run WHERE id = $1;
