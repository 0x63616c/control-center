package work_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestDefaultConfigIsUsableWithoutAnUpdate(t *testing.T) {
	t.Parallel()

	cfg := work.DefaultConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("DefaultConfig().Validate() = %v, want nil — the worker starts on this before any signal arrives", err)
	}
	if cfg.Paused {
		t.Error("DefaultConfig() starts paused; a deploy would then do nothing until a human noticed")
	}
	for _, stage := range work.Pipeline() {
		if got := cfg.ModelFor(stage); got.Name == "" || got.Effort == "" {
			t.Errorf("DefaultConfig().ModelFor(%s) = %+v, want a fully specified model", stage, got)
		}
	}
}

func TestConfigRejectsAStoppedStateThatIsNotPaused(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		cfg  work.Config
	}{
		{"zero cap", withCap(0)},
		{"negative cap", withCap(-1)},
		{"zero cooldown", withCooldown(0)},
		{"negative cooldown", withCooldown(-30)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if err := tc.cfg.Validate(); err == nil {
				t.Errorf("Validate() = nil for %s; a cap of zero is a second way to pause and a cooldown of zero is a breaker that reopens instantly", tc.name)
			}
		})
	}
}

func TestConfigRejectsAHalfSpecifiedModel(t *testing.T) {
	t.Parallel()

	noEffort := work.DefaultConfig()
	noEffort.DefaultModel.Effort = ""
	if err := noEffort.Validate(); err == nil {
		t.Error("Validate() = nil for a default model with no effort; codex would be invoked with an empty --config value")
	}

	badOverride := work.DefaultConfig()
	badOverride.StageModels.Review = &work.Model{Effort: "high"}
	if err := badOverride.Validate(); err == nil {
		t.Error("Validate() = nil for a review override with no model name")
	}
}

// Effort is deliberately not validated against a list. Verified against
// codex rust-v0.145.0: ReasoningEffort carries a Custom(String) arm for
// "a model-defined effort value that this client does not know yet", so an
// allowlist here would reject values codex accepts, and would rot.
func TestConfigAcceptsAnEffortThisServiceHasNeverHeardOf(t *testing.T) {
	t.Parallel()

	cfg := work.DefaultConfig()
	cfg.StageModels.Plan = &work.Model{Name: "gpt-5.6-terra", Effort: "ultra"}
	if err := cfg.Validate(); err != nil {
		t.Errorf("Validate() = %v for an unrecognised effort; codex accepts arbitrary effort strings and this must not be the thing that blocks a new one", err)
	}
}

func TestModelForPrefersTheStageOverride(t *testing.T) {
	t.Parallel()

	cfg := work.DefaultConfig()
	cfg.StageModels.Review = &work.Model{Name: "other-model", Effort: "high"}

	if got, want := cfg.ModelFor(work.StageReview), (work.Model{Name: "other-model", Effort: "high"}); got != want {
		t.Errorf("ModelFor(review) = %+v, want %+v", got, want)
	}
	if got, want := cfg.ModelFor(work.StagePlan), cfg.DefaultModel; got != want {
		t.Errorf("ModelFor(plan) = %+v, want the default %+v — one override must not move another stage", got, want)
	}
}

func TestApplyLeavesUnsetFieldsAlone(t *testing.T) {
	t.Parallel()

	before := work.DefaultConfig()
	before.StageModels.Implement = &work.Model{Name: "other-model", Effort: "high"}

	after, err := before.Apply(work.ConfigUpdate{})
	if err != nil {
		t.Fatalf("Apply(ConfigUpdate{}) = %v, want nil", err)
	}
	if after.MaxInFlight != before.MaxInFlight ||
		after.BreakerCooldownSeconds != before.BreakerCooldownSeconds ||
		after.DefaultModel != before.DefaultModel ||
		after.Paused != before.Paused {
		t.Errorf("Apply(ConfigUpdate{}) = %+v, want %+v — an empty update is what a deploy sends when it changes nothing", after, before)
	}
	if got := after.ModelFor(work.StageImplement); got != *before.StageModels.Implement {
		t.Errorf("ModelFor(implement) = %+v after an empty update, want the existing override %+v", got, *before.StageModels.Implement)
	}
}

func TestApplySetsOnlyWhatItNames(t *testing.T) {
	t.Parallel()

	paused := true
	limit := 4
	before := work.DefaultConfig()

	after, err := before.Apply(work.ConfigUpdate{Paused: &paused, MaxInFlight: &limit})
	if err != nil {
		t.Fatalf("Apply() = %v, want nil", err)
	}
	if !after.Paused {
		t.Error("Apply(Paused: true) did not pause; pausing by hand is one of the two things this signal exists for")
	}
	if after.MaxInFlight != 4 {
		t.Errorf("MaxInFlight = %d, want 4", after.MaxInFlight)
	}
	if after.BreakerCooldownSeconds != before.BreakerCooldownSeconds {
		t.Errorf("BreakerCooldownSeconds = %d, want the untouched %d", after.BreakerCooldownSeconds, before.BreakerCooldownSeconds)
	}
	if before.Paused {
		t.Error("Apply mutated its receiver; the dispatcher holds the old config until it accepts the new one")
	}
}

func TestApplyReplacesTheWholeOverrideSet(t *testing.T) {
	t.Parallel()

	before := work.DefaultConfig()
	before.StageModels.Review = &work.Model{Name: "other-model", Effort: "high"}

	after, err := before.Apply(work.ConfigUpdate{StageModels: &work.StageModels{
		Plan: &work.Model{Name: "other-model", Effort: "low"},
	}})
	if err != nil {
		t.Fatalf("Apply() = %v, want nil", err)
	}
	if got, want := after.ModelFor(work.StagePlan), (work.Model{Name: "other-model", Effort: "low"}); got != want {
		t.Errorf("ModelFor(plan) = %+v, want %+v", got, want)
	}
	if got := after.ModelFor(work.StageReview); got != after.DefaultModel {
		t.Errorf("ModelFor(review) = %+v, want the default %+v — a set that omits review clears review", got, after.DefaultModel)
	}
}

func TestApplyRejectsAnInvalidUpdateWholesale(t *testing.T) {
	t.Parallel()

	limit := 0
	paused := true
	before := work.DefaultConfig()

	after, err := before.Apply(work.ConfigUpdate{Paused: &paused, MaxInFlight: &limit})
	if err == nil {
		t.Fatal("Apply(MaxInFlight: 0) = nil error, want one")
	}
	if after != before {
		t.Errorf("Apply() = %+v on failure, want the unchanged %+v — a half-applied config is one nobody asked for", after, before)
	}
}

func TestApplyOverridesSurviveAJSONRoundTrip(t *testing.T) {
	t.Parallel()

	// The signal payload crosses Temporal as JSON, so a field the converter
	// cannot carry is a config change that silently does nothing.
	limit := 3
	cooldown := int64(60)
	want := work.ConfigUpdate{
		MaxInFlight:            &limit,
		BreakerCooldownSeconds: &cooldown,
		StageModels:            &work.StageModels{Propose: &work.Model{Name: "other-model", Effort: "low"}},
	}

	encoded, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("json.Marshal(ConfigUpdate) = %v", err)
	}
	var got work.ConfigUpdate
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("json.Unmarshal(%s) = %v", encoded, err)
	}

	applied, err := work.DefaultConfig().Apply(got)
	if err != nil {
		t.Fatalf("Apply(round-tripped) = %v", err)
	}
	if applied.MaxInFlight != 3 || applied.BreakerCooldownSeconds != 60 {
		t.Errorf("round-tripped update applied as %+v, want cap 3 and cooldown 60s", applied)
	}
	if got, want := applied.ModelFor(work.StagePropose), (work.Model{Name: "other-model", Effort: "low"}); got != want {
		t.Errorf("ModelFor(propose) = %+v after a round trip, want %+v", got, want)
	}
}

func TestBreakerCooldownReadsAsADuration(t *testing.T) {
	t.Parallel()

	cfg := work.DefaultConfig()
	cfg.BreakerCooldownSeconds = 90

	if got, want := cfg.BreakerCooldown(), 90*time.Second; got != want {
		t.Errorf("BreakerCooldown() = %v, want %v", got, want)
	}
}

func TestBreakerIsOpenUntilItsDeadline(t *testing.T) {
	t.Parallel()

	tripped := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	breaker := work.Breaker{OpenUntil: tripped.Add(15 * time.Minute), Reason: "rate limited"}

	if !breaker.OpenAt(tripped) {
		t.Error("OpenAt(trip time) = false; the breaker must stop new work the moment it trips")
	}
	if !breaker.OpenAt(tripped.Add(14 * time.Minute)) {
		t.Error("OpenAt(inside the cooldown) = false")
	}
	if breaker.OpenAt(tripped.Add(15 * time.Minute)) {
		t.Error("OpenAt(deadline) = true; the deadline is when work resumes, not the last instant it is blocked")
	}
}

func TestZeroBreakerIsClosed(t *testing.T) {
	t.Parallel()

	// The dispatcher's breaker starts as the zero value, and a zero time.Time
	// is far in the past — so "never tripped" must not read as "open forever".
	if (work.Breaker{}).OpenAt(time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)) {
		t.Error("a never-tripped breaker reads as open; the dispatcher would start no work at all")
	}
}

func withCap(limit int) work.Config {
	cfg := work.DefaultConfig()
	cfg.MaxInFlight = limit
	return cfg
}

func withCooldown(seconds int64) work.Config {
	cfg := work.DefaultConfig()
	cfg.BreakerCooldownSeconds = seconds
	return cfg
}

func TestStatusAnswersTheQuestionsAskedOfARunningDispatcher(t *testing.T) {
	t.Parallel()

	// A query result crosses Temporal as JSON, so a field that does not survive
	// the trip is a question the operator gets a wrong answer to rather than no
	// answer at all.
	tripped := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	want := work.Status{
		Config:      work.DefaultConfig(),
		InFlight:    []int{312, 330},
		Breaker:     work.Breaker{OpenUntil: tripped, Reason: "rate limited"},
		ConfigError: "MaxInFlight must be at least 1",
	}

	encoded, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("json.Marshal(Status) = %v", err)
	}
	var got work.Status
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("json.Unmarshal(%s) = %v", encoded, err)
	}

	if len(got.InFlight) != 2 || got.InFlight[0] != 312 || got.InFlight[1] != 330 {
		t.Errorf("InFlight = %v, want [312 330]", got.InFlight)
	}
	if !got.Breaker.OpenUntil.Equal(tripped) || got.Breaker.Reason != want.Breaker.Reason {
		t.Errorf("Breaker = %+v, want %+v", got.Breaker, want.Breaker)
	}
	if got.Config.MaxInFlight != want.Config.MaxInFlight || got.Config.Paused != want.Config.Paused {
		t.Errorf("Config = %+v, want %+v", got.Config, want.Config)
	}
	if got.ConfigError != want.ConfigError {
		t.Errorf("ConfigError = %q, want %q — a rejected signal is otherwise invisible", got.ConfigError, want.ConfigError)
	}
}
