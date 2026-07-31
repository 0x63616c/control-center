-- name: CreateTicket :one
INSERT INTO ticket (title, body, state) VALUES ($1, $2, $3) RETURNING *;

-- name: GetTicket :one
SELECT * FROM ticket WHERE id = $1;

-- name: ListTicketsByState :many
SELECT * FROM ticket WHERE state = $1 ORDER BY created_at, id;

-- name: SetTicketState :one
UPDATE ticket SET state = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *;

-- name: AddDependency :exec
INSERT INTO ticket_edge (blocker_ticket_id, blocked_ticket_id) VALUES ($1, $2);

-- name: RemoveDependency :exec
DELETE FROM ticket_edge WHERE blocker_ticket_id = $1 AND blocked_ticket_id = $2;

-- name: ListTicketBlockers :many
SELECT t.* FROM ticket t JOIN ticket_edge e ON e.blocker_ticket_id = t.id WHERE e.blocked_ticket_id = $1 ORDER BY t.id;

-- name: ListTicketsBlockedBy :many
SELECT t.* FROM ticket t JOIN ticket_edge e ON e.blocked_ticket_id = t.id WHERE e.blocker_ticket_id = $1 ORDER BY t.id;

-- name: ListReadyTickets :many
SELECT t.* FROM ticket t WHERE t.state = 'open' AND NOT EXISTS (
  SELECT 1 FROM ticket_edge e JOIN ticket blocker ON blocker.id = e.blocker_ticket_id
  WHERE e.blocked_ticket_id = t.id AND blocker.state <> 'done'
) ORDER BY t.created_at, t.id;

-- name: StartRun :one
INSERT INTO run (id, ticket_id, started_at) VALUES ($1, $2, $3) RETURNING *;

-- name: EndRun :one
UPDATE run SET ended_at = $2, outcome = $3, failure_kind = $4 WHERE id = $1 RETURNING *;

-- name: RecordStep :one
INSERT INTO step (run_id, stage, turn) VALUES ($1, $2, $3) RETURNING *;

-- name: StartAttempt :one
INSERT INTO attempt (run_id, stage, turn, attempt_no, model, effort, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, measured, started_at)
VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, FALSE, $7) RETURNING *;

-- name: EndAttempt :one
UPDATE attempt SET ended_at = $5, result = $6, input_tokens = $7, cached_input_tokens = $8, output_tokens = $9, reasoning_tokens = $10, measured = $11
WHERE run_id = $1 AND stage = $2 AND turn = $3 AND attempt_no = $4 RETURNING *;

-- name: UpsertTranscript :one
INSERT INTO transcript (run_id, stage, turn, attempt_no, compressed_bytes, compression, uncompressed_size_bytes, checksum)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (run_id, stage, turn, attempt_no) DO UPDATE SET compressed_bytes = EXCLUDED.compressed_bytes, compression = EXCLUDED.compression, uncompressed_size_bytes = EXCLUDED.uncompressed_size_bytes, checksum = EXCLUDED.checksum
RETURNING *;

-- name: GetTranscript :one
SELECT * FROM transcript WHERE run_id = $1 AND stage = $2 AND turn = $3 AND attempt_no = $4;

-- name: GetRun :one
SELECT * FROM run WHERE id = $1;

-- name: ListRunSteps :many
SELECT * FROM step WHERE run_id = $1 ORDER BY stage, turn;

-- name: ListRunAttempts :many
SELECT * FROM attempt WHERE run_id = $1 ORDER BY stage, turn, attempt_no;

-- name: GetDispatcherState :one
SELECT * FROM dispatcher_state WHERE singleton = TRUE;

-- name: SetDispatcherState :one
UPDATE dispatcher_state SET paused = $1, max_in_flight = $2, breaker_open_until = $3, breaker_reason = $4, in_flight = $5, next_ticket_id = $6, written_at = $7 WHERE singleton = TRUE RETURNING *;
