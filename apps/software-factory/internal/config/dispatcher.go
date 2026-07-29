package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// envDispatcherConfig holds the dispatcher's starting configuration, as the
// same JSON an operator would send in an UpdateConfig signal.
//
// One grammar, not two. The alternative — a variable per field — would be a
// second way to say the same things, and the two would drift the first time a
// field was added to one of them.
const envDispatcherConfig = "DISPATCHER_CONFIG"

// LoadDispatcher returns the configuration the dispatcher starts on: the
// defaults, with whatever DISPATCHER_CONFIG names applied over them.
//
// Unset is not an error. work.DefaultConfig is valid and running rather than
// paused, deliberately: a deploy that lost its configuration should do the
// normal thing loudly rather than sit idle looking healthy.
//
// What is an error is a configuration that was written and cannot be honoured.
// This runs at startup, so a bad value crashloops the pod with the reason in
// its logs — which is the loudest channel this system has. The same JSON
// arriving later as a signal has no way to fail back to its sender at all.
func LoadDispatcher() (work.Config, error) {
	raw := strings.TrimSpace(os.Getenv(envDispatcherConfig))
	if raw == "" {
		return work.DefaultConfig(), nil
	}

	// Decoded as a ConfigUpdate rather than a Config, and this is the whole
	// point of the type it decodes into: ConfigUpdate refuses a key it does
	// not have a field for, while Config does not. `{"pausd":true}` decoded
	// into a Config succeeds, changes nothing, and leaves the operator to
	// discover it by noticing the system still doing what they told it to
	// stop doing. It also gives absence a meaning — leave that field alone —
	// so this variable states the differences from the defaults rather than
	// having to restate all of them.
	// `null` is valid JSON and unmarshals into a zero ConfigUpdate, which
	// applies nothing and yields the defaults — silently. That is not a typo an
	// operator makes; it is what a templating system produces when the value it
	// was asked to interpolate did not exist, which is precisely when somebody
	// believes they configured something. Rejected by name so the pod says so.
	if raw == "null" {
		return work.Config{}, fmt.Errorf(
			"%s is null, which would start the dispatcher on the defaults while looking configured: unset it to mean the defaults, or give it an object",
			envDispatcherConfig)
	}

	// Note on duplicate keys: encoding/json takes the LAST occurrence, so
	// `{"maxInFlight":1,"maxInFlight":9}` is 9 and no error is raised. Nothing
	// here can improve on that without a second parser, and hand-written JSON
	// in a Deployment is where it would happen. Worth knowing before reading a
	// config that appears to disagree with itself.
	var update work.ConfigUpdate
	if err := json.Unmarshal([]byte(raw), &update); err != nil {
		return work.Config{}, fmt.Errorf("%s is not a dispatcher configuration: %w", envDispatcherConfig, err)
	}

	// Apply validates the result, so nothing invalid can leave here. Nothing
	// downstream re-checks it, and a config that reached the dispatcher
	// invalid would fail its first cycle long after the deploy went green.
	cfg, err := work.DefaultConfig().Apply(update)
	if err != nil {
		return work.Config{}, fmt.Errorf("%s: %w", envDispatcherConfig, err)
	}
	return cfg, nil
}
