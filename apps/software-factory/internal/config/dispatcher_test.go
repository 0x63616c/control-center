package config

import (
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// setDispatcherConfig installs DISPATCHER_CONFIG for one test, so a value left
// over from the shell cannot make one pass.
func setDispatcherConfig(t *testing.T, value string) {
	t.Helper()
	t.Setenv(envDispatcherConfig, value)
}

func TestLoadDispatcherRunsOnTheDefaultsWhenNothingIsSet(t *testing.T) {
	setDispatcherConfig(t, "")

	got, err := LoadDispatcher()
	if err != nil {
		t.Fatalf("LoadDispatcher: %v", err)
	}
	// A deploy that carries no config should do the normal thing, not sit idle
	// looking healthy.
	if got != work.DefaultConfig() {
		t.Errorf("LoadDispatcher = %+v, want the defaults %+v", got, work.DefaultConfig())
	}
	if got.Paused {
		t.Error("a worker with no configuration started paused")
	}
}

func TestLoadDispatcherChangesOnlyWhatTheUpdateNames(t *testing.T) {
	setDispatcherConfig(t, `{"maxInFlight":4}`)

	got, err := LoadDispatcher()
	if err != nil {
		t.Fatalf("LoadDispatcher: %v", err)
	}
	defaults := work.DefaultConfig()
	switch {
	case got.MaxInFlight != 4:
		t.Errorf("MaxInFlight = %d, want 4", got.MaxInFlight)
	case got.BreakerCooldownSeconds != defaults.BreakerCooldownSeconds:
		t.Errorf("BreakerCooldownSeconds = %d, want the default %d left alone", got.BreakerCooldownSeconds, defaults.BreakerCooldownSeconds)
	case got.DefaultModel != defaults.DefaultModel:
		t.Errorf("DefaultModel = %+v, want the default %+v left alone", got.DefaultModel, defaults.DefaultModel)
	}
}

func TestLoadDispatcherRefusesAKeyItDoesNotKnow(t *testing.T) {
	// The whole reason this decodes a ConfigUpdate rather than a Config:
	// Config is not strict, so this misspelling would decode into it with a
	// nil error and change nothing, and the operator would learn about it by
	// noticing the system still doing what they told it to stop doing.
	setDispatcherConfig(t, `{"pausd":true}`)

	_, err := LoadDispatcher()
	if err == nil {
		t.Fatal("LoadDispatcher accepted a misspelled key and started on a configuration nobody wrote")
	}
	if !strings.Contains(err.Error(), "pausd") {
		t.Errorf("error %q does not name the key it rejected", err)
	}
}

func TestLoadDispatcherRefusesAConfigurationItCannotRun(t *testing.T) {
	cases := []struct {
		name  string
		value string
	}{
		{name: "a cap below one", value: `{"maxInFlight":0}`},
		{name: "a breaker that reopens immediately", value: `{"breakerCooldownSeconds":0}`},
		{name: "a model with no name", value: `{"defaultModel":{"effort":"high"}}`},
		{name: "a stage override that is not a stage", value: `{"stageModels":{"planning":{"name":"m","effort":"low"}}}`},
		{name: "not JSON at all", value: `paused=true`},
		{name: "a JSON array", value: `[{"paused":true}]`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setDispatcherConfig(t, tc.value)

			_, err := LoadDispatcher()
			if err == nil {
				t.Fatalf("LoadDispatcher accepted %s", tc.value)
			}
			// The pod is crashlooping by the time anyone reads this, so the
			// variable's own name is where the fix starts.
			if !strings.Contains(err.Error(), envDispatcherConfig) {
				t.Errorf("error %q does not name %s", err, envDispatcherConfig)
			}
		})
	}
}

func TestLoadDispatcherOnlyEverReturnsAConfigThatRuns(t *testing.T) {
	cases := []struct {
		name  string
		value string
	}{
		{name: "nothing set", value: ""},
		{name: "an empty update", value: `{}`},
		{name: "paused deliberately", value: `{"paused":true}`},
		{name: "every field at once", value: `{"paused":false,"maxInFlight":3,"breakerCooldownSeconds":600,` +
			`"defaultModel":{"name":"gpt-5.6-terra","effort":"high"},` +
			`"stageModels":{"review":{"name":"gpt-5.6-terra","effort":"low"}}}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setDispatcherConfig(t, tc.value)

			got, err := LoadDispatcher()
			if err != nil {
				t.Fatalf("LoadDispatcher: %v", err)
			}
			// Nothing downstream re-checks this. A config that reached the
			// dispatcher invalid would be a workflow that fails on its first
			// cycle, after the deploy has gone green.
			if err := got.Validate(); err != nil {
				t.Errorf("LoadDispatcher returned a config that does not validate: %v", err)
			}
		})
	}
}

func TestLoadDispatcherAppliesEveryFieldItIsGiven(t *testing.T) {
	setDispatcherConfig(t, `{"paused":true,"maxInFlight":3,"breakerCooldownSeconds":600,`+
		`"defaultModel":{"name":"gpt-5.6-terra","effort":"high"},`+
		`"stageModels":{"review":{"name":"gpt-5.6-terra","effort":"low"}}}`)

	got, err := LoadDispatcher()
	if err != nil {
		t.Fatalf("LoadDispatcher: %v", err)
	}
	switch {
	case !got.Paused:
		t.Error("Paused was not applied")
	case got.MaxInFlight != 3:
		t.Errorf("MaxInFlight = %d, want 3", got.MaxInFlight)
	case got.BreakerCooldownSeconds != 600:
		t.Errorf("BreakerCooldownSeconds = %d, want 600", got.BreakerCooldownSeconds)
	case got.ModelFor(work.StagePlan) != (work.Model{Name: "gpt-5.6-terra", Effort: "high"}):
		t.Errorf("plan model = %+v, want the default model", got.ModelFor(work.StagePlan))
	case got.ModelFor(work.StageReview) != (work.Model{Name: "gpt-5.6-terra", Effort: "low"}):
		t.Errorf("review model = %+v, want the override", got.ModelFor(work.StageReview))
	}
}

// TestTheDispatcherConfigVariableIsTheNameTheDeploymentSets pins the variable's
// spelling against a literal.
//
// Every other test here sets and reads through envDispatcherConfig, so they
// agree with a rename by construction. Nothing in this repository is the
// consumer: the Deployment writes this name, and a rename here means a worker
// that silently starts on the defaults while the operator's JSON sits in an
// environment variable nothing reads. worker_test.go pins its seven the same
// way, and this is the eighth.
func TestTheDispatcherConfigVariableIsTheNameTheDeploymentSets(t *testing.T) {
	const published = "DISPATCHER_CONFIG"

	if envDispatcherConfig != published {
		t.Errorf("envDispatcherConfig = %q, want %q; the Deployment sets this exact name and a rename starts the dispatcher on the defaults in silence",
			envDispatcherConfig, published)
	}

	t.Setenv(published, `{"maxInFlight":3}`)
	cfg, err := LoadDispatcher()
	if err != nil {
		t.Fatalf("LoadDispatcher: %v", err)
	}
	if cfg.MaxInFlight != 3 {
		t.Errorf("MaxInFlight = %d, want 3; the literal name did not reach the loader", cfg.MaxInFlight)
	}
}

// TestANullConfigIsRefusedRatherThanTreatedAsTheDefaults covers the templating
// accident, not the typo. `null` is valid JSON, unmarshals into a zero
// ConfigUpdate and applies nothing, so the dispatcher would start on the
// defaults looking configured — and that is exactly what an interpolation of a
// value that did not exist produces.
func TestANullConfigIsRefusedRatherThanTreatedAsTheDefaults(t *testing.T) {
	t.Setenv(envDispatcherConfig, "null")

	if _, err := LoadDispatcher(); err == nil {
		t.Fatal("LoadDispatcher accepted null and started on the defaults; an operator who templated a missing value would see a healthy pod running settings nobody chose")
	}
}

// TestAnUnsetConfigStillMeansTheDefaults is the other half of the case above:
// refusing null must not turn "I did not configure this" into a crashloop.
func TestAnUnsetConfigStillMeansTheDefaults(t *testing.T) {
	t.Setenv(envDispatcherConfig, "")

	cfg, err := LoadDispatcher()
	if err != nil {
		t.Fatalf("LoadDispatcher with nothing set: %v", err)
	}
	if cfg.MaxInFlight != work.DefaultConfig().MaxInFlight {
		t.Errorf("unset did not yield the defaults: %+v", cfg)
	}
}
