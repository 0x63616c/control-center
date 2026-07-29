package codexauth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// remedy is the one sentence every fatal message ends with, because for all of
// them the next step is the same and it is a human's.
const remedy = "run `codex login` locally and re-seed the secret with scripts/seed-codex-auth.sh"

// Source yields a currently-valid model access token, refreshing and rotating
// the stored credential when one nears expiry. It implements
// activities.TokenSource.
//
// It is the only writer of the credential. Exclusion is a lease taken on the
// stored object BEFORE the refresh token is presented, so it holds across
// processes and not merely across goroutines — see the package doc.
type Source struct {
	store     SecretStore
	refresher TokenRefresher
	clock     clock.Clock
	log       *slog.Logger
	holder    string
	metrics   Metrics

	margin         time.Duration
	refreshTimeout time.Duration
	leaseTTL       time.Duration
	leasePoll      time.Duration
	waitRounds     int
	storeAttempts  int
	storeBackoff   time.Duration

	// gate is a capacity-1 channel rather than a mutex because a mutex has no
	// context-aware acquire: a caller blocked behind another's refresh could
	// not honour its own cancellation, and with 60-minute stage contexts it
	// could outlive its own deadline by an hour and defeat graceful drain.
	//
	// It is not the correctness mechanism. It collapses N concurrent callers
	// in one process into one read instead of N reads and N-1 lease conflicts.
	// Remove it and the system is correct and noisy; remove the lease and it
	// is broken.
	gate chan struct{}
}

// New constructs a Source. Required dependencies are positional; everything
// tunable is an option with a default that is correct for this service.
//
// holder is positional rather than optional because a lease with a defaulted or
// empty holder identity cannot be attributed at 3am, which is the only hour
// anyone reads one. The composition root passes `<pod name>/<short random>`;
// the suffix distinguishes two runs of the same pod name.
func New(store SecretStore, refresher TokenRefresher, clk clock.Clock, log *slog.Logger, holder string, opts ...Option) (*Source, error) {
	o := options{
		metrics:        noMetrics{},
		margin:         defaultRefreshMargin,
		refreshTimeout: defaultRefreshTimeout,
		leaseTTL:       defaultLeaseTTL,
		leasePoll:      defaultLeasePoll,
		waitRounds:     defaultWaitRounds,
		storeAttempts:  defaultStoreAttempts,
		storeBackoff:   defaultStoreBackoff,
	}
	for _, opt := range opts {
		opt(&o)
	}

	switch {
	case store == nil:
		return nil, fmt.Errorf("a codex token source needs a secret store")
	case refresher == nil:
		return nil, fmt.Errorf("a codex token source needs a token refresher")
	case clk == nil:
		return nil, fmt.Errorf("a codex token source needs a clock")
	case log == nil:
		return nil, fmt.Errorf("a codex token source needs a logger")
	case holder == "":
		return nil, fmt.Errorf("a codex token source needs a holder identity: an unattributable lease cannot be investigated")
	case o.metrics == nil:
		return nil, fmt.Errorf("a codex token source needs a metrics recorder")
	case o.margin <= 0 || o.refreshTimeout <= 0 || o.leaseTTL <= 0 || o.leasePoll <= 0:
		return nil, fmt.Errorf("a codex token source needs positive durations")
	case o.waitRounds < 1 || o.storeAttempts < 1 || o.storeBackoff <= 0:
		return nil, fmt.Errorf("a codex token source needs at least one wait round and one store attempt")
	case o.leaseTTL <= o.refreshTimeout:
		// The takeover policy rests on the lease outlasting the presentation
		// it bounds. Equal or shorter, an expired lease no longer means "the
		// holder is not coming back".
		return nil, fmt.Errorf("the lease TTL (%s) must outlast the presentation it bounds (%s)", o.leaseTTL, o.refreshTimeout)
	}

	return &Source{
		store: store, refresher: refresher, clock: clk, log: log, holder: holder,
		metrics:        o.metrics,
		margin:         o.margin,
		refreshTimeout: o.refreshTimeout,
		leaseTTL:       o.leaseTTL,
		leasePoll:      o.leasePoll,
		waitRounds:     o.waitRounds,
		storeAttempts:  o.storeAttempts,
		storeBackoff:   o.storeBackoff,
		gate:           make(chan struct{}, 1),
	}, nil
}

// AccessToken returns a token valid for at least the refresh margin.
func (s *Source) AccessToken(ctx context.Context) (work.Credential, error) {
	select {
	case s.gate <- struct{}{}:
		defer func() { <-s.gate }()
	case <-ctx.Done():
		return work.Credential{}, fmt.Errorf("waiting to read the codex credential: %w", ctx.Err())
	}

	waitingOn := ""
	for range s.waitRounds {
		result, err := s.round(ctx)
		if result.done || err != nil {
			return result.token, err
		}
		if result.waitingOn != "" {
			waitingOn = result.waitingOn
		}
		if err := s.clock.Sleep(ctx, s.leasePoll); err != nil {
			return work.Credential{}, fmt.Errorf("waiting for the codex credential to be refreshed: %w", err)
		}
	}
	if waitingOn == "" {
		waitingOn = "another holder"
	}
	return work.Credential{}, fmt.Errorf("%s held the lease for the whole of our wait: %w", waitingOn, ErrRefreshInProgress)
}

// Validate reports whether a usable credential is stored. It reads and parses
// and does nothing else: it never presents the refresh token and never writes.
//
// Worker boot is the first moment of a Recreate rollout, which is the one
// window in which a terminating pod may still hold the lease, so a boot check
// that could refresh would schedule a presentation into the least safe moment
// in the service's life.
//
// An unresolved attempt is a warning rather than an error. The stored access
// token is good for days while the refresh token behind it may already be
// spent, so failing boot would refuse to start a worker that works — but saying
// nothing would let the discovery happen days later with no context left.
func (s *Source) Validate(ctx context.Context) error {
	values, _, err := s.store.Get(ctx)
	if err != nil {
		return s.readError(err)
	}
	_, state, _, err := s.parse(values)
	if err != nil {
		return err
	}

	att := state.Attempt
	if att == nil || att.Serial != state.Serial {
		return nil
	}
	switch {
	case att.Outcome == outcomeRejected:
		s.metrics.CredentialDead(DeathRejected)
		s.log.WarnContext(ctx, "the provider has already refused this codex refresh token, so the stored access token is the last one",
			"holder", att.Holder, "serial", att.Serial, "remedy", remedy)
	case !att.live(s.clock.Now()):
		s.metrics.CredentialDead(DeathOutcomeUnknown)
		s.log.WarnContext(ctx, "a previous refresh of the codex credential never settled, so its refresh token may already be spent",
			"holder", att.Holder, "started_at", att.StartedAt, "serial", att.Serial, "remedy", remedy)
	}
	return nil
}

// roundResult is one pass of the read-decide-refresh loop. done means the call
// is over — with an answer, or with something a re-read cannot change.
type roundResult struct {
	token     work.Credential
	done      bool
	waitingOn string
}

func (s *Source) round(ctx context.Context) (roundResult, error) {
	values, version, err := s.store.Get(ctx)
	if err != nil {
		return roundResult{done: true}, s.readError(err)
	}
	cred, state, exp, err := s.parse(values)
	if err != nil {
		return roundResult{done: true}, err
	}

	now := s.clock.Now()
	if now.Add(s.margin).Before(exp) {
		// The overwhelmingly common path: no write, no network, no lease.
		return roundResult{token: cred.access, done: true}, nil
	}
	return s.refresh(ctx, cred, state, version, now)
}

// parse turns the stored bytes into a credential, its lease state and its
// expiry. Every failure here is unseeded and permanent, and every one of them
// is recorded as a death because the only fix is a human.
func (s *Source) parse(values map[string][]byte) (credentialFile, refreshState, time.Time, error) {
	cred, err := parseCredentialFile(values[CredentialKey])
	if err != nil {
		s.metrics.CredentialDead(DeathUnseeded)
		return credentialFile{}, refreshState{}, time.Time{}, s.unusable(err)
	}
	state, err := parseRefreshState(values[StateKey])
	if err != nil {
		s.metrics.CredentialDead(DeathUnseeded)
		return credentialFile{}, refreshState{}, time.Time{}, s.unusable(err)
	}
	exp, err := expiryOf(cred.access)
	if err != nil {
		s.metrics.CredentialDead(DeathUnseeded)
		return credentialFile{}, refreshState{}, time.Time{}, s.unusable(fmt.Errorf("%w: %w", err, ErrUnseeded))
	}
	return cred, state, exp, nil
}

// readError distinguishes a secret that is not there from one we could not
// read. Collapsing the two would turn an apiserver blip into a demand for a
// browser login, and a genuinely absent secret into an endless retry.
func (s *Source) readError(err error) error {
	if errors.Is(err, work.ErrSecretNotFound) {
		s.metrics.CredentialDead(DeathUnseeded)
		return s.unusable(fmt.Errorf("the secret holding %s does not exist: %w", CredentialKey, ErrUnseeded))
	}
	return fmt.Errorf("reading the codex credential secret: %w", err)
}

// unusable appends the one remedy every fatal condition here shares.
func (s *Source) unusable(err error) error {
	return fmt.Errorf("%w — %s", err, remedy)
}

// refresh takes the lease, presents the token, and settles the result.
//
// The ordering is the mechanism. The compare-and-swap that takes the lease
// happens BEFORE the token is presented, so of N actors holding one version
// exactly one reaches the provider — cross-process, cross-node, including a
// terminating pod during a rollout. A conflict here is contention and nothing
// destructive has happened, so it re-reads; a conflict AFTER presenting is news
// and never re-presents.
func (s *Source) refresh(ctx context.Context, cred credentialFile, state refreshState, version work.SecretVersion, now time.Time) (roundResult, error) {
	takeoverOf := ""
	if att := state.Attempt; att != nil && att.Serial == state.Serial {
		switch {
		case att.Outcome == outcomeRejected:
			// Somebody already learned this token is dead. Learning it again
			// costs a round trip and teaches nobody anything.
			s.metrics.CredentialDead(DeathRejected)
			return roundResult{done: true}, s.unusable(fmt.Errorf("%s recorded that the provider refused this credential: %w", att.Holder, ErrRefreshRejected))

		case att.live(now):
			// Not ours to take. Nothing was presented, so this re-reads.
			return roundResult{waitingOn: att.Holder}, nil

		case att.TakeoverOf != "":
			// The one takeover per generation is spent. A second would be a
			// third presentation of a token whose first two outcomes are both
			// unknown.
			s.metrics.CredentialDead(DeathOutcomeUnknown)
			return roundResult{done: true}, s.unusable(fmt.Errorf(
				"%s took over %s's unsettled refresh and did not settle either, so this token may already be spent: %w",
				att.Holder, att.TakeoverOf, ErrRefreshOutcomeUnknown))

		default:
			// An expired, unresolved, not-yet-taken-over attempt: its holder
			// died mid-refresh, which at deploy time is ordinary rather than
			// exotic. Taking over once recovers it; see the package doc for
			// why once is safe and twice is not.
			takeoverOf = att.Holder
		}
	}

	leaseState := refreshState{
		Serial:     state.Serial,
		LastWriter: state.LastWriter,
		Attempt: &attempt{
			Holder:         s.holder,
			StartedAt:      now,
			LeaseExpiresAt: now.Add(s.leaseTTL),
			Serial:         state.Serial,
			TakeoverOf:     takeoverOf,
		},
	}
	leaseBytes, err := encodeRefreshState(leaseState)
	if err != nil {
		return roundResult{done: true}, err
	}
	leaseVersion, err := s.store.Put(ctx, map[string][]byte{StateKey: leaseBytes}, version)
	if err != nil {
		if errors.Is(err, work.ErrVersionConflict) {
			// Contention, and nothing has been presented. The next read
			// usually finds a token somebody else already rotated.
			return roundResult{}, nil
		}
		return roundResult{done: true}, fmt.Errorf("taking the codex refresh lease: %w", err)
	}
	if takeoverOf != "" {
		s.metrics.Takeover()
		s.log.ErrorContext(ctx, "taking over an unsettled codex refresh, whose token may already be spent",
			"holder", s.holder, "takeover_of", takeoverOf, "serial", state.Serial)
	}

	// A worker draining on SIGTERM must not begin something it cannot finish.
	if err := ctx.Err(); err != nil {
		s.releaseLease(ctx, leaseState, leaseVersion)
		return roundResult{done: true}, fmt.Errorf("cancelled before presenting the codex refresh token: %w", err)
	}

	return s.present(ctx, cred, state, leaseState, leaseVersion)
}

// present hands the refresh token to the provider and acts on what came back.
func (s *Source) present(ctx context.Context, cred credentialFile, state, leaseState refreshState, leaseVersion work.SecretVersion) (roundResult, error) {
	// Logged before the call, not after: the token is spent the instant the
	// request lands, so evidence written only on success is missing in exactly
	// the case that needs it.
	s.log.InfoContext(ctx, "presenting the codex refresh token",
		"holder", s.holder, "serial", state.Serial, "lease_expires_at", leaseState.Attempt.LeaseExpiresAt)

	rctx, cancel := context.WithTimeout(ctx, s.refreshTimeout)
	defer cancel()
	res, outcome, err := s.refresher.Refresh(rctx, cred.refresh)
	s.metrics.RefreshOutcome(outcome)

	switch outcome {
	case RefreshNotSent:
		// DNS failure, connection refused, TLS handshake failure. The token
		// was definitely not presented, so this stays an ordinary blip rather
		// than a manual browser login — which is what makes the strictness
		// everywhere else affordable.
		s.releaseLease(ctx, leaseState, leaseVersion)
		return roundResult{done: true}, fmt.Errorf("the codex refresh request never reached the provider: %w", err)

	case RefreshUnknown:
		// Deliberately left unresolved. The marker is what stops the next
		// caller, and the next process, presenting a token that may already
		// be spent.
		s.metrics.CredentialDead(DeathOutcomeUnknown)
		s.log.ErrorContext(ctx, "a codex refresh reached the provider with no usable answer, so its token may already be spent",
			"holder", s.holder, "serial", state.Serial, "cause", err, "remedy", remedy)
		return roundResult{done: true}, s.unusable(fmt.Errorf("%w: %w", ErrRefreshOutcomeUnknown, err))

	case RefreshRejected:
		s.metrics.CredentialDead(DeathRejected)
		s.settleRejected(ctx, state, leaseState, leaseVersion)
		return roundResult{done: true}, s.unusable(fmt.Errorf("%w: %w", ErrRefreshRejected, err))

	case RefreshRotated:
		token, err := s.settle(ctx, cred, state, leaseVersion, res)
		return roundResult{token: token, done: true}, err
	}
	// Unreachable: the switch is exhaustive and the linter enforces it. An
	// outcome from the future is treated as unknown, which is the only safe
	// reading of a value this code does not understand.
	s.metrics.CredentialDead(DeathOutcomeUnknown)
	return roundResult{done: true}, s.unusable(fmt.Errorf("%w (unrecognised outcome %s)", ErrRefreshOutcomeUnknown, outcome))
}

// settle stores the rotated pair and clears the lease, in one write.
func (s *Source) settle(ctx context.Context, cred credentialFile, state refreshState, leaseVersion work.SecretVersion, res Refreshed) (work.Credential, error) {
	ourSerial := state.Serial + 1
	authBytes, err := cred.withRotation(res, s.clock.Now())
	if err != nil {
		return work.Credential{}, s.credentialLost(err)
	}
	stateBytes, err := encodeRefreshState(refreshState{Serial: ourSerial, LastWriter: s.holder})
	if err != nil {
		return work.Credential{}, s.credentialLost(err)
	}
	// One write, so the rotated credential and the cleared lease share a
	// linearization point. Preconditioned on the version our own lease write
	// produced, so nothing that landed in between is silently adopted.
	values := map[string][]byte{CredentialKey: authBytes, StateKey: stateBytes}

	if _, err := s.store.Put(ctx, values, leaseVersion); err != nil {
		return s.recoverSettle(ctx, values, state, ourSerial, res, err)
	}
	s.log.InfoContext(ctx, "rotated the codex credential", "holder", s.holder, "serial", ourSerial)
	return s.usable(res)
}

// recoverSettle works out whether a failed settle actually landed.
//
// It keys on a serial and a writer identity THIS process chose and wrote, never
// on comparing token bytes. "My own write landed and the response was lost" is
// the likeliest failure in the system, and a check that could not tell it from
// a foreign writer would turn the commonest blip into the most expensive
// outcome there is.
func (s *Source) recoverSettle(
	ctx context.Context,
	values map[string][]byte,
	prev refreshState,
	ourSerial int64,
	res Refreshed,
	cause error,
) (work.Credential, error) {
	backoff := s.storeBackoff
	for range s.storeAttempts - 1 {
		if err := s.clock.Sleep(ctx, backoff); err != nil {
			return work.Credential{}, s.credentialLost(fmt.Errorf("cancelled while storing a rotated credential: %w", err))
		}
		backoff *= 2

		observed, version, err := s.store.Get(ctx)
		if err != nil {
			cause = err
			continue
		}
		state, err := parseRefreshState(observed[StateKey])
		if err != nil {
			return work.Credential{}, s.unusable(err)
		}

		switch {
		case state.Serial == ourSerial && state.LastWriter == s.holder:
			s.log.WarnContext(ctx, "a codex rotation was stored but its confirmation was lost; recovered by reading it back",
				"holder", s.holder, "serial", ourSerial)
			return s.usable(res)

		case state.Serial == prev.Serial && state.Attempt != nil &&
			state.Attempt.Holder == s.holder && state.Attempt.Serial == prev.Serial:
			// Our lease is still there and the generation has not moved, so
			// the write did not land: the version moved for a foreign reason,
			// or not at all.
			if _, err := s.store.Put(ctx, values, version); err != nil {
				cause = err
				continue
			}
			s.log.InfoContext(ctx, "rotated the codex credential", "holder", s.holder, "serial", ourSerial)
			return s.usable(res)

		default:
			s.metrics.CredentialDead(DeathSingleWriterViolated)
			s.log.ErrorContext(ctx, "INV-1 violated: something other than this source rotated the codex credential",
				"our_holder", s.holder, "our_serial", ourSerial,
				"observed_writer", state.LastWriter, "observed_serial", state.Serial, "remedy", remedy)
			return work.Credential{}, s.unusable(fmt.Errorf(
				"expected serial %d written by %s, found serial %d written by %q: %w",
				ourSerial, s.holder, state.Serial, state.LastWriter, ErrSingleWriterViolated))
		}
	}

	s.metrics.CredentialDead(DeathCredentialLost)
	s.log.ErrorContext(ctx, "a rotated codex credential could not be stored; the previous refresh token is already spent",
		"holder", s.holder, "serial", ourSerial, "cause", cause, "remedy", remedy)
	return work.Credential{}, s.credentialLost(cause)
}

// usable checks that a rotated token is worth handing out, having already
// stored it.
func (s *Source) usable(res Refreshed) (work.Credential, error) {
	exp, err := expiryOf(res.AccessToken)
	if err != nil {
		s.metrics.CredentialDead(DeathUnseeded)
		return work.Credential{}, s.unusable(fmt.Errorf("%w: %w", err, ErrUnseeded))
	}
	if !s.clock.Now().Add(s.margin).Before(exp) {
		// A provider behaviour change, not a bug of ours. The pair is stored
		// either way — dropping it would spend a single-use token for nothing
		// — but handing it to a sandbox would hand over a credential the
		// sandbox will try, and fail, to refresh.
		s.metrics.CredentialDead(DeathCredentialLost)
		return work.Credential{}, s.unusable(fmt.Errorf("it expires at %s, inside the %s refresh margin: %w", exp.Format(time.RFC3339), s.margin, ErrRefreshTooShortLived))
	}
	return res.AccessToken, nil
}

func (s *Source) credentialLost(cause error) error {
	return s.unusable(fmt.Errorf("%w: %w", ErrCredentialLost, cause))
}

// releaseLease clears an attempt that provably presented nothing, so the next
// caller need not wait out the TTL.
//
// Best effort: an unresolved marker is a correct if vaguer signal, and failing
// the call over a failed cleanup would report a problem that does not exist. It
// detaches from the caller's context because releasing is exactly what must
// still happen when that context is what cancelled us.
func (s *Source) releaseLease(ctx context.Context, leaseState refreshState, version work.SecretVersion) {
	cleared, err := encodeRefreshState(refreshState{Serial: leaseState.Serial, LastWriter: leaseState.LastWriter})
	if err != nil {
		s.log.WarnContext(ctx, "could not encode a released codex refresh lease", "holder", s.holder, "error", err)
		return
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.refreshTimeout)
	defer cancel()
	if _, err := s.store.Put(rctx, map[string][]byte{StateKey: cleared}, version); err != nil {
		s.log.WarnContext(ctx, "could not release the codex refresh lease; it will expire on its own",
			"holder", s.holder, "lease_expires_at", leaseState.Attempt.LeaseExpiresAt, "error", err)
	}
}

// settleRejected records a refusal so the next caller need not learn it again
// by presenting a token already known to be dead.
func (s *Source) settleRejected(ctx context.Context, state, leaseState refreshState, version work.SecretVersion) {
	settled := leaseState
	settled.Attempt = &attempt{
		Holder:         s.holder,
		StartedAt:      leaseState.Attempt.StartedAt,
		LeaseExpiresAt: leaseState.Attempt.LeaseExpiresAt,
		Serial:         state.Serial,
		TakeoverOf:     leaseState.Attempt.TakeoverOf,
		Outcome:        outcomeRejected,
	}
	encoded, err := encodeRefreshState(settled)
	if err != nil {
		s.log.WarnContext(ctx, "could not encode a rejected codex refresh outcome", "holder", s.holder, "error", err)
		return
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), s.refreshTimeout)
	defer cancel()
	if _, err := s.store.Put(rctx, map[string][]byte{StateKey: encoded}, version); err != nil {
		s.log.WarnContext(ctx, "could not record that the provider refused the codex refresh token", "holder", s.holder, "error", err)
	}
	s.log.ErrorContext(ctx, "the provider refused the codex refresh token; it is spent or revoked",
		"holder", s.holder, "serial", state.Serial, "remedy", remedy)
}
