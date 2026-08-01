package workflows

import "go.temporal.io/sdk/workflow"

func AgentToolActivityOptionsForTest() workflow.ActivityOptions { return agentToolActivityOptions() }
