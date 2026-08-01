package main

import (
	"testing"

	"go.temporal.io/sdk/activity"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities"
	agentactivities "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/activities/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
)

type activityRegistration struct {
	value any
	name  string
}

type activityRegistrarProbe struct{ registrations []activityRegistration }

func (p *activityRegistrarProbe) RegisterActivity(value any) {
	p.registrations = append(p.registrations, activityRegistration{value: value})
}

func (p *activityRegistrarProbe) RegisterActivityWithOptions(value any, options activity.RegisterOptions) {
	p.registrations = append(p.registrations, activityRegistration{value: value, name: options.Name})
}

func TestRunWorkerRegistersTypedToolsAndRepositoryActivitiesOnly(t *testing.T) {
	t.Parallel()

	registrar := &activityRegistrarProbe{}
	register(registrar, &agentactivities.ToolActivities{}, &activities.RunWorkerActivities{})

	if len(registrar.registrations) != 2 {
		t.Fatalf("registered activity count = %d, want 2", len(registrar.registrations))
	}
	if registrar.registrations[0].name != agent.ToolActivityName {
		t.Fatalf("typed tool activity name = %q, want %q", registrar.registrations[0].name, agent.ToolActivityName)
	}
	if _, ok := registrar.registrations[1].value.(*activities.RunWorkerActivities); !ok {
		t.Fatalf("second registration = %T, want repository-affine RunWorkerActivities", registrar.registrations[1].value)
	}
}
