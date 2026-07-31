package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildEndpointAndOpenAPI(t *testing.T) {
	service := New("test-build")

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
}
