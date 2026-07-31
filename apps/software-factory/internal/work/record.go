package work

import "time"

// TicketID identifies a factory-owned ticket.
type TicketID int64

// TicketState is the lifecycle state of a factory ticket.
type TicketState string

const (
	// TicketStateOpen is filed and eligible once its blockers are done.
	TicketStateOpen TicketState = "open"
	// TicketStateWorking has a run in flight.
	TicketStateWorking TicketState = "working"
	// TicketStateReview awaits human review of a proposed pull request.
	TicketStateReview TicketState = "review"
	// TicketStateDone is terminal and satisfies direct dependencies.
	TicketStateDone TicketState = "done"
	// TicketStateFailed is terminal and does not satisfy direct dependencies.
	TicketStateFailed TicketState = "failed"
)

// FactoryTicket is the factory-owned work item, distinct from a GitHub Ticket.
type FactoryTicket struct {
	ID        TicketID
	Title     string
	Body      string
	State     TicketState
	CreatedAt time.Time
	UpdatedAt time.Time
}

// AttemptKey identifies one execution of a stage step.
type AttemptKey struct {
	StageKey
	AttemptNo int
}

// AttemptResult is how one attempt ended.
type AttemptResult string

const (
	// AttemptSucceeded means the sandbox completed the stage.
	AttemptSucceeded AttemptResult = "succeeded"
	// AttemptFailed means the sandbox did not complete the stage.
	AttemptFailed AttemptResult = "failed"
)

// RunRecord is one durable execution of a factory ticket.
type RunRecord struct {
	ID          string
	TicketID    TicketID
	StartedAt   time.Time
	EndedAt     *time.Time
	Outcome     *Outcome
	FailureKind FailureKind
}

// StepRecord is one stage turn within a run.
type StepRecord struct{ Key StageKey }

// AttemptRecord is one execution of a step.
type AttemptRecord struct {
	Key       AttemptKey
	Model     Model
	Usage     Usage
	Measured  bool
	StartedAt time.Time
	EndedAt   *time.Time
	Result    *AttemptResult
}

// RunDetail is a run with the rows the console renders beneath it.
type RunDetail struct {
	Run      RunRecord
	Steps    []StepRecord
	Attempts []AttemptRecord
}

// StoredTranscript is the compressed transcript for an attempt.
type StoredTranscript struct {
	Key                   AttemptKey
	CompressedBytes       []byte
	Compression           string
	UncompressedSizeBytes int64
	Checksum              []byte
}

// DispatcherState is the persisted singleton dispatcher snapshot.
type DispatcherState struct {
	Paused       bool
	MaxInFlight  int
	Breaker      Breaker
	InFlight     []InFlightTicket
	NextTicketID *TicketID
	WrittenAt    time.Time
}
