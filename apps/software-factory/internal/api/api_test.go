package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type commandFake struct {
	updates  []work.ConfigUpdate
	canceled []int
	err      error
}

func (fake *commandFake) UpdateConfig(_ context.Context, update work.ConfigUpdate) error {
	fake.updates = append(fake.updates, update)
	return fake.err
}

func (fake *commandFake) CancelTicket(_ context.Context, ticketID int) error {
	fake.canceled = append(fake.canceled, ticketID)
	return fake.err
}

func TestBuildEndpointAndOpenAPI(t *testing.T) {
	service := New("test-build", nil)

	request := httptest.NewRequest(http.MethodGet, "/v1/build", nil)
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET /v1/build status = %d, want %d", response.Code, http.StatusOK)
	}
	if got := response.Body.String(); !strings.Contains(got, "test-build") {
		t.Fatalf("GET /v1/build body = %q, want build version", got)
	}

	spec, err := service.OpenAPIYAML()
	if err != nil {
		t.Fatalf("OpenAPIYAML() error = %v", err)
	}
	if !strings.Contains(string(spec), "openapi: 3.1.0") || !strings.Contains(string(spec), "/v1/build:") {
		t.Fatalf("OpenAPIYAML() = %s, want OpenAPI 3.1 build path", spec)
	}
	for _, requirement := range []string{"cloudflareAccess:", "Cf-Access-Jwt-Assertion", "inClusterBearer:", "scheme: bearer"} {
		if !strings.Contains(string(spec), requirement) {
			t.Fatalf("OpenAPIYAML() missing security requirement %q", requirement)
		}
	}
}

func TestCommandsTranslateHTTPRequestsToDispatcherCommands(t *testing.T) {
	t.Parallel()

	commands := &commandFake{}
	service := New("test-build", commands)
	for _, test := range []struct {
		name   string
		path   string
		body   string
		assert func(*testing.T)
	}{
		{
			name: "pause", path: "/v1/factory/pause",
			assert: func(t *testing.T) {
				if len(commands.updates) != 1 || commands.updates[0].Paused == nil || !*commands.updates[0].Paused {
					t.Fatalf("updates = %#v, want paused config update", commands.updates)
				}
			},
		},
		{
			name: "resume", path: "/v1/factory/resume",
			assert: func(t *testing.T) {
				if len(commands.updates) != 2 || commands.updates[1].Paused == nil || *commands.updates[1].Paused {
					t.Fatalf("updates = %#v, want resumed config update", commands.updates)
				}
			},
		},
		{
			name: "max in flight", path: "/v1/factory/max-in-flight", body: `{"maxInFlight":4}`,
			assert: func(t *testing.T) {
				if len(commands.updates) != 3 || commands.updates[2].MaxInFlight == nil || *commands.updates[2].MaxInFlight != 4 {
					t.Fatalf("updates = %#v, want max-in-flight config update", commands.updates)
				}
			},
		},
		{
			name: "work now", path: "/v1/tickets/42/work",
			assert: func(t *testing.T) {
				if len(commands.updates) != 4 || commands.updates[3] != (work.ConfigUpdate{}) {
					t.Fatalf("updates = %#v, want empty config update", commands.updates)
				}
			},
		},
		{
			name: "cancel", path: "/v1/tickets/42/cancel",
			assert: func(t *testing.T) {
				if len(commands.canceled) != 1 || commands.canceled[0] != 42 {
					t.Fatalf("canceled = %#v, want ticket 42", commands.canceled)
				}
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			service.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Fatalf("POST %s status = %d, want %d: %s", test.path, response.Code, http.StatusNoContent, response.Body.String())
			}
			test.assert(t)
		})
	}
}

func TestCommandsMapWorkflowFailuresToHTTPResponses(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name string
		err  error
		want int
	}{
		{"unknown workflow", work.ErrWorkflowNotFound, http.StatusNotFound},
		{"closed workflow", work.ErrWorkflowClosed, http.StatusConflict},
		{"transient failure", errors.New("Temporal unavailable"), http.StatusServiceUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := New("test-build", &commandFake{err: test.err})
			request := httptest.NewRequest(http.MethodPost, "/v1/tickets/42/cancel", nil)
			response := httptest.NewRecorder()
			service.Handler().ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
		})
	}
}
