-- +goose Up
-- The dispatcher_state row was the legacy GitHub-backed dispatcher's post-tick
-- projection (#551). Nothing has written it since PR #616 retired that
-- dispatcher, so it is now permanently stale data with no live source —
-- drop it rather than leave it lying to an operator reading the console.
DROP TABLE dispatcher_state;

-- +goose Down
CREATE TABLE dispatcher_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
    in_flight JSONB NOT NULL DEFAULT '[]'::JSONB,
    written_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    config JSONB NOT NULL DEFAULT '{}'::JSONB,
    config_error TEXT NOT NULL DEFAULT '',
    breaker JSONB NOT NULL DEFAULT '{}'::JSONB,
    candidates JSONB NOT NULL DEFAULT '[]'::JSONB,
    free_slots INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT dispatcher_state_singleton_check CHECK (singleton),
    CONSTRAINT dispatcher_state_candidates_array_check CHECK (JSONB_TYPEOF(candidates) = 'array'),
    CONSTRAINT dispatcher_state_free_slots_check CHECK (free_slots >= 0)
);
INSERT INTO dispatcher_state (singleton) VALUES (TRUE);
