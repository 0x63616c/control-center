package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	factoryapi "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/api"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/checkpoint"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

func TestOpenAPICommandPrintsSpecWithoutStartupConfig(t *testing.T) {
	t.Setenv("SOFTWARE_FACTORY_DATABASE_URL", "")
	var stdout bytes.Buffer
	cli := newCLI(&stdout, &bytes.Buffer{})
	cli.Root().SetArgs([]string{"openapi"})
	cli.Run()
	if got := stdout.String(); !strings.Contains(got, "openapi: 3.1.0") || !strings.Contains(got, "/v1/build:") {
		t.Fatalf("openapi output = %q, want OpenAPI build endpoint", got)
	}
}

type testRouteAuthenticator struct{}

func (testRouteAuthenticator) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer legacy-api" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(writer, request)
	})
}

type checkpointStore struct{}

func (checkpointStore) CheckpointAgentAttempt(_ context.Context, input store.AgentCheckpointInput) (store.AgentAttempt, error) {
	return store.AgentAttempt{ID: input.ID, State: input.State}, nil
}

func (checkpointStore) LoadAgentCheckpoint(_ context.Context, id store.TargetAttemptID, _ string) (store.AgentAttempt, *store.TargetTranscript, bool, error) {
	return store.AgentAttempt{ID: id, ProviderThreadID: "thread-1", State: work.AgentAttemptRunning, UsageState: work.UsageUnknown}, nil, true, nil
}

func TestFactoryRoutingUsesAttemptCapabilityWithoutWeakeningLegacyAuthentication(t *testing.T) {
	t.Parallel()

	factory := factoryapi.NewWithCheckpointStore("test-build", nil, checkpointStore{})
	mux := http.NewServeMux()
	mountFactoryAPI(mux, testRouteAuthenticator{}, factory)

	legacy := httptest.NewRequest(http.MethodGet, "/v1/build", nil)
	legacyResponse := httptest.NewRecorder()
	mux.ServeHTTP(legacyResponse, legacy)
	if legacyResponse.Code != http.StatusUnauthorized {
		t.Fatalf("legacy route without bearer = %d, want 401", legacyResponse.Code)
	}

	body := strings.NewReader(`{"providerThreadId":"thread-1","state":"running","usageState":"unknown","usage":{"inputTokens":0,"cachedInputTokens":0,"outputTokens":0,"reasoningTokens":0}}`)
	checkpointRequest := httptest.NewRequest(http.MethodPut, checkpoint.AttemptPath("0f466627-b3ae-4ba2-9c96-6ef44ec6f578", 1, 1), body)
	checkpointRequest.Header.Set("Content-Type", "application/json")
	checkpointRequest.Header.Set(checkpoint.CapabilityHeader, "attempt-capability")
	checkpointResponse := httptest.NewRecorder()
	mux.ServeHTTP(checkpointResponse, checkpointRequest)
	if checkpointResponse.Code != http.StatusNoContent {
		t.Fatalf("checkpoint route without broad bearer = %d: %s", checkpointResponse.Code, checkpointResponse.Body.String())
	}

	checkpointRead := httptest.NewRequest(http.MethodGet, checkpoint.AttemptPath("0f466627-b3ae-4ba2-9c96-6ef44ec6f578", 1, 1), nil)
	checkpointRead.Header.Set(checkpoint.CapabilityHeader, "attempt-capability")
	checkpointReadResponse := httptest.NewRecorder()
	mux.ServeHTTP(checkpointReadResponse, checkpointRead)
	if checkpointReadResponse.Code != http.StatusOK {
		t.Fatalf("checkpoint GET without broad bearer = %d: %s", checkpointReadResponse.Code, checkpointReadResponse.Body.String())
	}

	futureRunWorkerRequest := httptest.NewRequest(http.MethodGet, "/v1/run-worker/future", nil)
	futureRunWorkerResponse := httptest.NewRecorder()
	mux.ServeHTTP(futureRunWorkerResponse, futureRunWorkerRequest)
	if futureRunWorkerResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unregistered Run Worker route without bearer = %d, want 401", futureRunWorkerResponse.Code)
	}

	legacy = httptest.NewRequest(http.MethodGet, "/v1/build", nil)
	legacy.Header.Set("Authorization", "Bearer legacy-api")
	legacyResponse = httptest.NewRecorder()
	mux.ServeHTTP(legacyResponse, legacy)
	if legacyResponse.Code != http.StatusOK {
		t.Fatalf("legacy route with bearer = %d: %s", legacyResponse.Code, legacyResponse.Body.String())
	}
}
