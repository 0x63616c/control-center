package config

import (
	"strings"
	"testing"
)

func TestLoadAPIRequiresDatabaseURL(t *testing.T) {
	t.Setenv(envAPIDatabaseURL, "")
	t.Setenv(envAPIListenAddr, ":8080")
	t.Setenv(envAPIMetricsAddr, ":9090")
	t.Setenv(envAccessTeamDomain, "test.cloudflareaccess.com")
	t.Setenv(envAccessAudience, "test-audience")
	t.Setenv(envAPIWorkerBearer, "test-worker-bearer")
	t.Setenv(envAPISandboxBearer, "test-sandbox-bearer")
	t.Setenv(envAPITemporalHost, "temporal:7233")
	t.Setenv(envAPITemporalNS, "software-factory")
	if _, err := LoadAPI(); err == nil || !strings.Contains(err.Error(), envAPIDatabaseURL) {
		t.Fatalf("LoadAPI() error = %v, want missing %s", err, envAPIDatabaseURL)
	}
}

func TestLoadAPIParsesAccessEndpoints(t *testing.T) {
	t.Setenv(envAPIDatabaseURL, "postgres://example")
	t.Setenv(envAPIListenAddr, ":8080")
	t.Setenv(envAPIMetricsAddr, ":9090")
	t.Setenv(envAccessTeamDomain, "test.cloudflareaccess.com")
	t.Setenv(envAccessAudience, "test-audience")
	t.Setenv(envAPIWorkerBearer, "test-worker-bearer")
	t.Setenv(envAPISandboxBearer, "test-sandbox-bearer")
	t.Setenv(envAPITemporalHost, "temporal:7233")
	t.Setenv(envAPITemporalNS, "software-factory")

	cfg, err := LoadAPI()
	if err != nil {
		t.Fatalf("LoadAPI() error = %v", err)
	}
	if cfg.AccessIssuer != "https://test.cloudflareaccess.com" || cfg.AccessCertsURL != "https://test.cloudflareaccess.com/cdn-cgi/access/certs" {
		t.Fatalf("Access endpoints = (%q, %q), want Cloudflare issuer and certificates URL", cfg.AccessIssuer, cfg.AccessCertsURL)
	}
}

func TestLoadAPIRejectsMalformedAccessDomain(t *testing.T) {
	t.Setenv(envAPIDatabaseURL, "postgres://example")
	t.Setenv(envAPIListenAddr, ":8080")
	t.Setenv(envAPIMetricsAddr, ":9090")
	t.Setenv(envAccessTeamDomain, "https://not-a-domain")
	t.Setenv(envAccessAudience, "test-audience")
	t.Setenv(envAPIWorkerBearer, "test-worker-bearer")
	t.Setenv(envAPISandboxBearer, "test-sandbox-bearer")
	t.Setenv(envAPITemporalHost, "temporal:7233")
	t.Setenv(envAPITemporalNS, "software-factory")

	if _, err := LoadAPI(); err == nil || !strings.Contains(err.Error(), envAccessTeamDomain) {
		t.Fatalf("LoadAPI() error = %v, want malformed %s", err, envAccessTeamDomain)
	}
}
