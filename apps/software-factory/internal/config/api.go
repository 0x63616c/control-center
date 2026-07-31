package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
)

const (
	envDatabaseURL      = "SOFTWARE_FACTORY_DATABASE_URL"
	envDatabaseUser     = "SOFTWARE_FACTORY_DATABASE_USER"
	envDatabasePassword = "SOFTWARE_FACTORY_DATABASE_PASSWORD"
	envDatabaseHost     = "SOFTWARE_FACTORY_DATABASE_HOST"
	envDatabaseName     = "SOFTWARE_FACTORY_DATABASE_NAME"
	envAPIListenAddr    = "API_ADDR"
	envAPIMetricsAddr   = "METRICS_ADDR"
	envAccessTeamDomain = "CLOUDFLARE_ACCESS_TEAM_DOMAIN"
	envAccessAudience   = "CLOUDFLARE_ACCESS_AUD"
	envAPIWorkerBearer  = "SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN"
	envAPISandboxBearer = "SOFTWARE_FACTORY_API__SANDBOX_BEARER_TOKEN"
	envAPITemporalHost  = "TEMPORAL_HOST_PORT"
	envAPITemporalNS    = "TEMPORAL_NAMESPACE"
)

// API is the parsed startup configuration for the factory API process.
type API struct {
	DatabaseURL       string
	ListenAddr        string
	MetricsAddr       string
	LogLevel          slog.Level
	AccessIssuer      string
	AccessAudience    string
	AccessCertsURL    string
	WorkerBearer      string
	SandboxBearer     string
	TemporalHostPort  string
	TemporalNamespace string
}

// LoadAPI parses all API process configuration before any external work begins.
func LoadAPI() (API, error) {
	teamDomain := os.Getenv(envAccessTeamDomain)
	databaseURL := os.Getenv(envDatabaseURL)
	if strings.TrimSpace(databaseURL) == "" {
		databaseURL = databaseURLFromParts(
			os.Getenv(envDatabaseUser), os.Getenv(envDatabasePassword),
			os.Getenv(envDatabaseHost), os.Getenv(envDatabaseName))
	}
	cfg := API{
		DatabaseURL:       databaseURL,
		ListenAddr:        os.Getenv(envAPIListenAddr),
		MetricsAddr:       os.Getenv(envAPIMetricsAddr),
		AccessAudience:    os.Getenv(envAccessAudience),
		WorkerBearer:      os.Getenv(envAPIWorkerBearer),
		SandboxBearer:     os.Getenv(envAPISandboxBearer),
		TemporalHostPort:  os.Getenv(envAPITemporalHost),
		TemporalNamespace: os.Getenv(envAPITemporalNS),
	}
	for _, required := range []struct{ name, value string }{
		{envDatabaseURL, cfg.DatabaseURL},
		{envAPIListenAddr, cfg.ListenAddr},
		{envAPIMetricsAddr, cfg.MetricsAddr},
		{envAccessTeamDomain, teamDomain},
		{envAccessAudience, cfg.AccessAudience},
		{envAPIWorkerBearer, cfg.WorkerBearer},
		{envAPISandboxBearer, cfg.SandboxBearer},
		{envAPITemporalHost, cfg.TemporalHostPort},
		{envAPITemporalNS, cfg.TemporalNamespace},
	} {
		if strings.TrimSpace(required.value) == "" {
			return API{}, fmt.Errorf("%s is required to start the API", required.name)
		}
	}
	issuer, certsURL, err := accessURLs(teamDomain)
	if err != nil {
		return API{}, err
	}
	cfg.AccessIssuer = issuer
	cfg.AccessCertsURL = certsURL
	level, err := logLevel()
	if err != nil {
		return API{}, err
	}
	cfg.LogLevel = level
	return cfg, nil
}

// accessURLs derives the only Access endpoints we trust from the configured team domain.
// Programmatic callers need a Service Auth policy or Access returns an IdP HTML page. The
// application also needs an Allow policy: Service Auth alone does not reliably include a JWT.
func accessURLs(teamDomain string) (string, string, error) {
	parsed, err := url.Parse("https://" + strings.TrimSpace(teamDomain))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || !strings.HasSuffix(parsed.Host, ".cloudflareaccess.com") {
		return "", "", fmt.Errorf("%s must be a Cloudflare Access team domain", envAccessTeamDomain)
	}
	issuer := "https://" + parsed.Host
	return issuer, issuer + "/cdn-cgi/access/certs", nil
}
