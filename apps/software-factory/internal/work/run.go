package work

import (
	"errors"
	"fmt"
	"time"
)

// ErrInvalidRun reports a run-shaped value the workflows cannot run on: a
// policy with no timeouts, a sandbox template with no image.
//
// It is separate from the errors Config.Validate returns because the two are
// answered by different people. A bad Config arrives on a signal and is
// reported back through Status.ConfigError; a bad RunPolicy or SandboxTemplate
// is a deploy that is wrong, and fails the workflow. Compare with errors.Is.
var ErrInvalidRun = errors.New("invalid run configuration")

// RunPolicy is the timing a WorkTicket run is held to: how long each stage
// gets, how long it may go quiet, and how often anything is retried.
//
// It is deliberately not part of Config. Config is what an operator changes on
// a live dispatcher through one signal; these are deploy-time numbers tied to
// the deadline ladder — stage timeout under run timeout under the pod's own
// deadline — and an operator moving one of them by hand would break an
// inequality nothing would report.
//
// **The zero value is not a policy.** Every field must be set and Validate
// refuses anything less, rather than a field here quietly becoming the second
// home of a number that already has one.
type RunPolicy struct {
	// StageTimeout is one stage's ceiling, start to close.
	StageTimeout time.Duration

	// StageHeartbeatTimeout is how long a stage may emit nothing before it is
	// treated as dead rather than slow. It is what makes an hour-long activity
	// cancellable instead of a black box.
	StageHeartbeatTimeout time.Duration

	// RunTimeout is what Temporal gives the whole run. It must exceed the
	// stages' own budget, and the sandbox pod's Kubernetes deadline must exceed
	// it in turn — that ladder is the invariant, and it is checked rather than
	// derived so this cannot quietly disagree with the numbers D1 declares.
	RunTimeout time.Duration

	// StageAttempts is deliberately small: a stage retry is a full
	// re-exploration of the repository, and quota is the binding cost.
	StageAttempts int32

	// ControlTimeout and ControlAttempts govern the cheap activities — status
	// comments, the label, pod lifecycle. The opposite trade: short, and
	// retried freely, because failing one would discard every token the run has
	// already spent.
	ControlTimeout  time.Duration
	ControlAttempts int32
}

// DefaultRunPolicy is the single source of ADR-0011's per-run numbers.
func DefaultRunPolicy() RunPolicy {
	// These are the deadline ladder D1 (#340) declares as MaxStageDuration,
	// StageHeartbeatTimeout and MaxRunDuration in internal/work/durations.go.
	// That file is not merged yet, so the values are written here rather than
	// referenced; when it lands these become references to it, and Validate's
	// inequality below is what stops the two disagreeing in the meantime.
	return RunPolicy{
		StageTimeout:          60 * time.Minute,
		StageHeartbeatTimeout: time.Minute,
		RunTimeout:            6 * time.Hour,
		StageAttempts:         2,
		ControlTimeout:        2 * time.Minute,
		ControlAttempts:       5,
	}
}

// Validate reports why this policy cannot run a ticket.
func (p RunPolicy) Validate() error {
	switch {
	case p.StageTimeout <= 0:
		return fmt.Errorf("%w: stage timeout must be positive", ErrInvalidRun)
	case p.StageHeartbeatTimeout <= 0:
		return fmt.Errorf("%w: stage heartbeat timeout must be positive", ErrInvalidRun)
	case p.StageHeartbeatTimeout >= p.StageTimeout:
		return fmt.Errorf("%w: a heartbeat timeout of %s can never fire inside a stage timeout of %s",
			ErrInvalidRun, p.StageHeartbeatTimeout, p.StageTimeout)
	case p.RunTimeout <= 0:
		return fmt.Errorf("%w: run timeout must be positive", ErrInvalidRun)
	case p.RunTimeout <= p.StageTimeout*time.Duration(len(Pipeline())):
		return fmt.Errorf("%w: a run timeout of %s cannot hold %d stages of %s each",
			ErrInvalidRun, p.RunTimeout, len(Pipeline()), p.StageTimeout)
	case p.StageAttempts <= 0:
		return fmt.Errorf("%w: stage attempts must be positive", ErrInvalidRun)
	case p.ControlTimeout <= 0:
		return fmt.Errorf("%w: control timeout must be positive", ErrInvalidRun)
	case p.ControlAttempts <= 0:
		return fmt.Errorf("%w: control attempts must be positive", ErrInvalidRun)
	}
	return nil
}

// RunBudget is the longest a run's stages can legitimately take: every stage
// using its whole timeout.
func (p RunPolicy) RunBudget() time.Duration {
	return p.StageTimeout * time.Duration(len(Pipeline()))
}

// DispatcherTuning is what paces the loop and is not the operator's business.
//
// The poll interval and the orphan grace ARE the operator's business and live
// on Config, where GetStatus and UpdateConfig can reach them — a knob an
// operator cannot reach from the place they look is a knob that does not exist.
// What is left here is the one number that is a property of the loop rather
// than a setting: the history ceiling.
type DispatcherTuning struct {
	// MaxHistoryEvents is when the dispatcher ContinueAsNews. A timer loop's
	// history is unbounded by construction, so this is not a tuning knob but
	// the thing that keeps the workflow alive — which is why it is here and not
	// on Config, where an operator could set it to something that stops the
	// loop bounding its own history.
	MaxHistoryEvents int
}

// DefaultDispatcherTuning is the single source of these three numbers.
func DefaultDispatcherTuning() DispatcherTuning {
	return DispatcherTuning{MaxHistoryEvents: 2000}
}

// Validate reports why the dispatcher cannot loop on this tuning.
func (t DispatcherTuning) Validate() error {
	if t.MaxHistoryEvents <= 0 {
		return fmt.Errorf("%w: history ceiling must be positive, or the dispatcher never continues as new", ErrInvalidRun)
	}
	return nil
}

// Outcome is how a WorkTicket run ended.
type Outcome string

const (
	// OutcomeProposed means a pull request is open. This is the only success.
	OutcomeProposed Outcome = "proposed"
	// OutcomeBlocked means the run decided it could not do the ticket and said
	// so on the issue. Not an error: a machine declining a ticket it does not
	// understand is the system working.
	OutcomeBlocked Outcome = "blocked"
	// OutcomeFailed means the run broke.
	OutcomeFailed Outcome = "failed"
)

// Proposed reports whether this outcome left a pull request behind.
func (o Outcome) Proposed() bool { return o == OutcomeProposed }

// FailureKind is what the dispatcher needs to know about a failure, and
// nothing more.
//
// Three values because the dispatcher does three different things: pause on a
// dead credential, wait out a rate limit, and carry on for anything else. It is
// not a retry taxonomy — that is ErrPermanent's one bit, translated once into
// Temporal's — but a report from a child run to its dispatcher about whether
// the system is still able to work at all.
type FailureKind string

const (
	// FailureNone means the run did not fail.
	FailureNone FailureKind = ""
	// FailureAuth means a credential is wrong, revoked or under-permissioned.
	// Nothing the dispatcher does next will work, so it pauses.
	FailureAuth FailureKind = "auth"
	// FailureRateLimit means a provider limit was reached. A wait, not a dead
	// system, so it trips the cooldown breaker.
	FailureRateLimit FailureKind = "rate-limit"
	// FailureOther is a failure local to one ticket. The ordinary case, and the
	// dispatcher does nothing about it beyond releasing the slot.
	FailureOther FailureKind = "other"
)

// IsFailure reports whether this kind describes a failure at all.
func (k FailureKind) IsFailure() bool { return k != FailureNone }

// TicketDone is what a WorkTicket run signals its dispatcher with when it
// finishes, however it finishes.
//
// It is how the dispatcher learns a slot is free without polling for it. The
// periodic reconcile is the backstop for a run that died without sending this,
// not the primary path — a signal is immediate and a reconcile is up to one
// poll interval late.
type TicketDone struct {
	Ticket  int
	RunID   string
	Outcome Outcome
	Failure FailureKind

	// Detail is what went wrong, for the dispatcher's log and its status. It is
	// never matched on.
	Detail string
}

// InFlightTicket is one ticket the dispatcher believes is being worked.
//
// Status reports the in-flight set as bare issue numbers, which is what an
// operator wants to read. This is what the dispatcher has to hold to be
// correct: the run ID is what tells a completion report from a superseded run
// apart from the current one, and what the orphan sweep matches a pod against.
type InFlightTicket struct {
	Ticket    int
	RunID     string
	StartedAt time.Time
}

// TrippedAt returns a breaker open for at least cooldown from now.
//
// At *least*: a second trip never shortens a cooldown already in force. Two
// rate limits in a row are more evidence for waiting, not less, and taking the
// shorter deadline would let a burst of cheap failures talk the dispatcher back
// into the wall.
//
// It is a method on Breaker rather than a field it sets, so the type stays a
// value whose only mutation is producing a new one.
func (b Breaker) TrippedAt(now time.Time, cooldown time.Duration, reason string) Breaker {
	until := now.Add(cooldown)
	if !until.After(b.OpenUntil) {
		return b
	}
	return Breaker{OpenUntil: until, Reason: reason}
}
