// Package api owns the factory's HTTP contract and Huma integration.
package api

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
)

// Service is the narrow API boundary exposed to composition roots.
type Service struct {
	handler http.Handler
	api     huma.API
}

type buildOutput struct {
	Body struct {
		Version string `json:"version" doc:"The build version running this API."`
	}
}

// New constructs the complete HTTP API. Version arrives from the composition
// root so this package does not need to learn about build metadata policy.
func New(version string) *Service {
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
	huma.Get(api, "/v1/build", func(_ context.Context, _ *struct{}) (*buildOutput, error) {
		output := &buildOutput{}
		output.Body.Version = version
		return output, nil
	})
	return &Service{handler: mux, api: api}
}

// Handler serves the typed API routes and Huma's generated OpenAPI documents.
func (s *Service) Handler() http.Handler { return s.handler }

// OpenAPIYAML returns the generated OpenAPI 3.1 document without starting HTTP.
func (s *Service) OpenAPIYAML() ([]byte, error) { return s.api.OpenAPI().YAML() }
