// Package api owns the factory's HTTP contract and Huma integration.
package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// Service is the narrow API boundary exposed to composition roots.
type Service struct {
	handler  http.Handler
	api      huma.API
	commands commandClient
}

// commandClient is the factory command surface the HTTP handlers need.
// Temporal stays sealed in its client package so browser-facing code never
// learns its SDK vocabulary or connection details.
type commandClient interface {
	UpdateConfig(context.Context, work.ConfigUpdate) error
	CancelTicket(context.Context, int) error
}

type buildOutput struct {
	Body struct {
		Version string `json:"version" doc:"The build version running this API."`
	}
}

type maxInFlightInput struct {
	Body struct {
		MaxInFlight int `json:"maxInFlight" minimum:"1" doc:"Maximum number of ticket runs the dispatcher may start at once."`
	}
}

type ticketInput struct {
	TicketID int `path:"ticketID" minimum:"1" doc:"The ticket number whose run is being commanded."`
}

// New constructs the complete HTTP API. Version arrives from the composition
// root so this package does not need to learn about build metadata policy.
func New(version string, commands commandClient) *Service {
	mux := http.NewServeMux()
	configuration := huma.DefaultConfig("Software Factory API", version)
	configuration.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		"cloudflareAccess": {
			Type: "apiKey", In: "header", Name: "Cf-Access-Jwt-Assertion",
			Description: "Cloudflare Access JWT assertion.",
		},
		"inClusterBearer": {
			Type: "http", Scheme: "bearer",
			Description: "Static bearer for in-cluster worker or sandbox callers.",
		},
	}
	configuration.Security = []map[string][]string{{"cloudflareAccess": {}}, {"inClusterBearer": {}}}
	api := humago.New(mux, configuration)
	service := &Service{handler: mux, api: api, commands: commands}
	huma.Get(api, "/v1/build", func(_ context.Context, _ *struct{}) (*buildOutput, error) {
		output := &buildOutput{}
		output.Body.Version = version
		return output, nil
	})
	huma.Post(api, "/v1/factory/pause", service.pause, commandOperation("Pause the factory", "Success means Temporal accepted the UpdateConfig signal. The dispatcher applies this configuration on its next tick; this endpoint does not poll for observable state."))
	huma.Post(api, "/v1/factory/resume", service.resume, commandOperation("Resume the factory", "Success means Temporal accepted the UpdateConfig signal. The dispatcher applies this configuration on its next tick; this endpoint does not poll for observable state."))
	huma.Post(api, "/v1/factory/max-in-flight", service.setMaxInFlight, commandOperation("Set factory max in flight", "Success means Temporal accepted the UpdateConfig signal. The dispatcher applies this configuration on its next tick; this endpoint does not poll for observable state."))
	huma.Post(api, "/v1/tickets/{ticketID}/cancel", service.cancelTicket, commandOperation("Cancel a ticket run", "Success means Temporal accepted cancellation of the ticket workflow. This endpoint does not wait for cleanup or database state to become observable."))
	huma.Post(api, "/v1/tickets/{ticketID}/work", service.workNow, commandOperation("Nudge the factory", "Success means Temporal accepted an empty UpdateConfig signal that wakes the dispatcher without changing configuration. This endpoint does not poll for observable state."))
	return service
}

func commandOperation(summary, description string) func(*huma.Operation) {
	return func(operation *huma.Operation) {
		operation.Summary = summary
		operation.Description = description
	}
}

// pause accepts the dispatcher configuration signal; it does not wait for the
// dispatcher to observe it, which happens on the next tick.
func (service *Service) pause(ctx context.Context, _ *struct{}) (*struct{}, error) {
	paused := true
	return service.updateConfig(ctx, work.ConfigUpdate{Paused: &paused})
}

// resume accepts the dispatcher configuration signal; it does not wait for the
// dispatcher to observe it, which happens on the next tick.
func (service *Service) resume(ctx context.Context, _ *struct{}) (*struct{}, error) {
	paused := false
	return service.updateConfig(ctx, work.ConfigUpdate{Paused: &paused})
}

// setMaxInFlight accepts the dispatcher configuration signal; it does not wait
// for the dispatcher to observe it, which happens on the next tick.
func (service *Service) setMaxInFlight(ctx context.Context, input *maxInFlightInput) (*struct{}, error) {
	return service.updateConfig(ctx, work.ConfigUpdate{MaxInFlight: &input.Body.MaxInFlight})
}

// workNow accepts an empty dispatcher configuration signal, waking its select
// without changing configuration; it does not wait for observable dispatch.
func (service *Service) workNow(ctx context.Context, _ *ticketInput) (*struct{}, error) {
	return service.updateConfig(ctx, work.ConfigUpdate{})
}

// cancelTicket accepts cancellation of the ticket workflow; it does not wait
// for terminal cleanup or any database state to become observable.
func (service *Service) cancelTicket(ctx context.Context, input *ticketInput) (*struct{}, error) {
	if service.commands == nil {
		return nil, huma.Error503ServiceUnavailable("factory commands are not configured")
	}
	if err := service.commands.CancelTicket(ctx, input.TicketID); err != nil {
		return nil, commandError(err)
	}
	return &struct{}{}, nil
}

func (service *Service) updateConfig(ctx context.Context, update work.ConfigUpdate) (*struct{}, error) {
	if service.commands == nil {
		return nil, huma.Error503ServiceUnavailable("factory commands are not configured")
	}
	if err := service.commands.UpdateConfig(ctx, update); err != nil {
		return nil, commandError(err)
	}
	return &struct{}{}, nil
}

func commandError(err error) error {
	switch {
	case errors.Is(err, work.ErrWorkflowNotFound):
		return huma.Error404NotFound("workflow does not exist")
	case errors.Is(err, work.ErrWorkflowClosed):
		return huma.Error409Conflict("workflow is already closed")
	default:
		return huma.Error503ServiceUnavailable("Temporal is temporarily unavailable")
	}
}

// Handler serves the typed API routes and Huma's generated OpenAPI documents.
func (s *Service) Handler() http.Handler { return s.handler }

// OpenAPIYAML returns the generated OpenAPI 3.1 document without starting HTTP.
func (s *Service) OpenAPIYAML() ([]byte, error) { return s.api.OpenAPI().YAML() }
