-- name: AddTicketDependency :exec
-- Cycle rejection is application-level, owned by the API ticket that creates
-- edges (ADR-0012) -- this query only records the edge.
INSERT INTO ticket_edge (blocker_ticket_id, blocked_ticket_id)
VALUES ($1, $2);

-- name: RemoveTicketDependency :exec
DELETE FROM ticket_edge
WHERE blocker_ticket_id = $1 AND blocked_ticket_id = $2;

-- name: TicketBlockers :many
-- Every ticket that blocks the given ticket.
SELECT blocker.* FROM ticket_edge e
JOIN ticket blocker ON blocker.id = e.blocker_ticket_id
WHERE e.blocked_ticket_id = $1
ORDER BY blocker.id;

-- name: TicketBlocks :many
-- Every ticket the given ticket blocks.
SELECT blocked.* FROM ticket_edge e
JOIN ticket blocked ON blocked.id = e.blocked_ticket_id
WHERE e.blocker_ticket_id = $1
ORDER BY blocked.id;
