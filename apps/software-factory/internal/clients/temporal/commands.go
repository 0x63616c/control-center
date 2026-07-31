// Package temporal seals the Temporal command client behind factory domain types.
package temporal

import (
	"context"
	"errors"
	"fmt"

	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/workflows"
)

type commandClient interface {
	SignalWorkflow(context.Context, string, string, string, interface{}) error
	CancelWorkflow(context.Context, string, string) error
}

// Commands sends factory control commands to Temporal.
type Commands struct {
	client commandClient
}

// NewCommands wraps a live Temporal client. The composition root owns its lifetime.
func NewCommands(temporal client.Client) *Commands {
	return &Commands{client: temporal}
}

// UpdateConfig sends the dispatcher's one supported control signal.
func (commands *Commands) UpdateConfig(ctx context.Context, update work.ConfigUpdate) error {
	err := commands.client.SignalWorkflow(ctx, work.DispatcherWorkflowID, "", workflows.SignalUpdateConfig, update)
	if err != nil {
		return classify("signal dispatcher configuration", err)
	}
	return nil
}

// CancelTicket requests cancellation so the ticket workflow can run its disconnected cleanup.
func (commands *Commands) CancelTicket(ctx context.Context, ticketID int) error {
	err := commands.client.CancelWorkflow(ctx, work.WorkflowID(ticketID), "")
	if err != nil {
		return classify(fmt.Sprintf("cancel ticket %d", ticketID), err)
	}
	return nil
}

func classify(operation string, err error) error {
	var notFound *serviceerror.NotFound
	if errors.As(err, &notFound) {
		return fmt.Errorf("%s: %w", operation, work.ErrWorkflowNotFound)
	}
	var failedPrecondition *serviceerror.FailedPrecondition
	if errors.As(err, &failedPrecondition) {
		return fmt.Errorf("%s: %w", operation, work.ErrWorkflowClosed)
	}
	return fmt.Errorf("%s: %w", operation, err)
}
