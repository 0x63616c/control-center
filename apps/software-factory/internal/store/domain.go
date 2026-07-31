// Package store is the factory's own Postgres store: sqlc-generated queries
// against the schema ADR-0012 defines, behind a narrow, consumer-side door.
//
// internal/store/storedb holds every pgx and sqlc-generated type; nothing
// outside this package imports it (enforced by .golangci.yml's
// store-generated-rows-are-sealed rule). Store's exported methods take and
// return this package's own domain types, reusing internal/work's StageKey,
// Stage, Model, Usage, Outcome and FailureKind rather than redefining them, so
// a caller never sees a database row and this package never invents a second
// spelling of a type that already exists.
//
// A row becomes one of these types exactly once, at the boundary a query
// returns across (SoftwareStyle: parse, don't validate) — a stored ticket
// state becomes a TicketState here and is never re-checked by a caller.
package store

import (
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// TicketID identifies a Ticket in the factory's own store, minted by the
// ticket table's identity column.
//
// It is a distinct type from a GitHub issue number on purpose: ADR-0012 fixes
// "Ticket" and "Issue" as two different things in two different systems, and
// internal/work.Ticket already names the GitHub-issue-shaped one. Reusing that
// name here for an unrelated integer would be exactly the confusion the
// vocabulary split exists to prevent.
type TicketID int64

// TicketState is a Ticket's lifecycle state.
//
// Five values, enforced twice: the ticket table's CHECK constraint is the
// database's wall, and Valid is Go's. Neither is a formality — a state read
// out of a row is trusted afterwards precisely because it passed one of these
// on the way in.
type TicketState string

// The five ticket states ADR-0012 fixes. No others exist.
const (
	// TicketOpen is filed, not started.
	TicketOpen TicketState = "open"
	// TicketWorking means a Run is in flight.
	TicketWorking TicketState = "working"
	// TicketReview means a Run produced a pull request; waiting on a human.
	TicketReview TicketState = "review"
	// TicketDone is terminal, and satisfies dependencies.
	TicketDone TicketState = "done"
	// TicketFailed is terminal, and does not satisfy dependencies. Never
	// auto-retried — a human moves a Ticket back to TicketOpen.
	TicketFailed TicketState = "failed"
)

// Valid reports whether s is one of the five states the schema enforces.
func (s TicketState) Valid() bool {
	switch s {
	case TicketOpen, TicketWorking, TicketReview, TicketDone, TicketFailed:
		return true
	default:
		return false
	}
}

// Ticket is a unit of work in the factory's own store.
//
// It is not a GitHub issue — see internal/work.Ticket for that, and ADR-0012's
// vocabulary table for why the two are never used interchangeably. There is no
// Source field: ADR-0012 records that one is trivially backfilled if a second
// origin ever exists, and adding it now would be speculative.
type Ticket struct {
	ID        TicketID
	Title     string
	Body      string
	State     TicketState
	CreatedAt time.Time
	UpdatedAt time.Time
}

// AttemptResult is how an Attempt ended, once it has.
//
// Empty means the attempt has not ended yet — EndAttempt has not been called
// for it — which is a different fact from either outcome below and must not be
// collapsed into one of them.
type AttemptResult string

// The two ways a recorded Attempt can end.
const (
	AttemptSucceeded AttemptResult = "succeeded"
	AttemptFailed    AttemptResult = "failed"
)

// Valid reports whether r is empty (not yet ended) or one of the two outcomes
// the schema allows.
func (r AttemptResult) Valid() bool {
	switch r {
	case "", AttemptSucceeded, AttemptFailed:
		return true
	default:
		return false
	}
}

// Attempt is one execution of a Step: which attempt it is, what it ran on,
// what it cost, and how it ended.
//
// Key identifies the Step (and, through StageKey.Ticket, the Run's Ticket) this
// attempt belongs to. The row's own primary key is (run, stage, turn,
// attempt_no) — Key.Ticket travels along for logging and error context, not
// because it is part of that key.
type Attempt struct {
	Key       work.StageKey
	AttemptNo int

	// Model is the model and reasoning effort this attempt ran on — on the
	// Attempt, never the Run, because a per-stage override can change it
	// between Steps in the same Run (ADR-0012).
	Model work.Model

	// Usage is the four token counts RecordAttempt was given. Zero and
	// Measured false means unknown, never zero spend — see Measured.
	Usage work.Usage

	// Measured reports whether this attempt actually ran Codex. A resumed
	// attempt returns a stored result without running anything and reports
	// Measured false with a zero Usage; rendering that as zero spend is #426,
	// which this field exists to stop reproducing.
	Measured bool

	StartedAt time.Time
	// EndedAt is the zero time until EndAttempt is called.
	EndedAt time.Time
	// Result is empty until EndAttempt is called.
	Result AttemptResult
}

// Transcript is one Attempt's compressed raw event stream, plus what is
// needed to store and verify it: which compression was used, the
// uncompressed size, and a checksum. Kept forever — ADR-0012 v0 has no
// retention marker.
type Transcript struct {
	Key                   work.StageKey
	AttemptNo             int
	CompressedBytes       []byte
	Compression           string
	UncompressedSizeBytes int64
	Checksum              []byte
}

// Run is one attempt at a whole Ticket — one Temporal workflow execution.
//
// ID is Temporal's run id for the enclosing workflow. Outcome and Failure are
// internal/work's own types, at their zero values (work.Outcome("") and
// work.FailureNone) until EndRun is called.
type Run struct {
	ID        string
	TicketID  TicketID
	StartedAt time.Time
	// EndedAt is the zero time until EndRun is called.
	EndedAt time.Time
	Outcome work.Outcome
	Failure work.FailureKind
}

// Step is one instance of a Stage inside a Run — exactly internal/work's
// StageKey, reused rather than redefined so a Step's identity never has two
// spellings.
type Step = work.StageKey

// RunDetail is a Run together with every Step it has recorded and every
// Attempt of each Step, oldest first — the console detail view's shape.
type RunDetail struct {
	Run   Run
	Steps []StepDetail
}

// StepDetail is one Step and the Attempts recorded against it.
type StepDetail struct {
	Stage    work.Stage
	Turn     int
	Attempts []Attempt
}

// InFlightTicket is one Ticket the new dispatcher believes is being worked.
//
// It is a distinct type from internal/work.InFlightTicket, whose Ticket field
// is a GitHub issue number: ADR-0012's cutover runs a second dispatcher
// alongside the first, reading TicketIDs from this store rather than issue
// numbers, and the two in-flight sets are never interchangeable.
type InFlightTicket struct {
	TicketID  TicketID  `json:"ticketId"`
	RunID     string    `json:"runId"`
	StartedAt time.Time `json:"startedAt"`
}

// DispatcherState is what the (new, ADR-0012) dispatcher knows, written once
// each tick — the single row that finally answers "what is it going to work
// on next", which nothing answers today.
type DispatcherState struct {
	Paused      bool
	MaxInFlight int
	// Breaker is the zero Breaker (never tripped) until the dispatcher trips it.
	Breaker  work.Breaker
	InFlight []InFlightTicket
	// NextTicketID is 0 if the dispatcher has no candidate.
	NextTicketID TicketID
	WrittenAt    time.Time
}
