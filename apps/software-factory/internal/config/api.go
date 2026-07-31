package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
)

const (
	envAPIDatabaseURL   = "SOFTWARE_FACTORY_DATABASE_URL"
	envAPIListenAddr    = "API_ADDR"
	envAPIMetricsAddr   = "METRICS_ADDR"
	envAccessTeamDomain = "CLOUDFLARE_ACCESS_TEAM_DOMAIN"
	envAccessAudience   = "CLOUDFLARE_ACCESS_AUD"
	envAPIWorkerBearer  = "SOFTWARE_FACTORY_API__WORKER_BEARER_TOKEN"
	envAPISandboxBearer = "SOFTWARE_FACTORY_API__SANDBOX_BEARER_TOKEN"
)

// API is the parsed startup configuration for the factory API process.
type API struct {
	DatabaseURL    string
	ListenAddr     string
	MetricsAddr    string
	LogLevel       slog.Level
	AccessIssuer   string
	AccessAudience string
	AccessCertsURL string
	WorkerBearer   string
	SandboxBearer  string
}

// LoadAPI parses all API process configuration before any external work begins.
func LoadAPI() (API, error) {
	teamDomain := os.Getenv(envAccessTeamDomain)
	cfg := API{
		DatabaseURL:    os.Getenv(envAPIDatabaseURL),
		ListenAddr:     os.Getenv(envAPIListenAddr),
		MetricsAddr:    os.Getenv(envAPIMetricsAddr),
		AccessAudience: os.Getenv(envAccessAudience),
		WorkerBearer:   os.Getenv(envAPIWorkerBearer),
		SandboxBearer:  os.Getenv(envAPISandboxBearer),
	}
	for _, required := range []struct{ name, value string }{
		{envAPIDatabaseURL, cfg.DatabaseURL},
		{envAPIListenAddr, cfg.ListenAddr},
		{envAPIMetricsAddr, cfg.MetricsAddr},
		{envAccessTeamDomain, teamDomain},
		{envAccessAudience, cfg.AccessAudience},
		{envAPIWorkerBearer, cfg.WorkerBearer},
		{envAPISandboxBearer, cfg.SandboxBearer},
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
