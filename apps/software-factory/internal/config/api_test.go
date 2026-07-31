package config

import (
	"strings"
	"testing"
)

func TestLoadAPIRequiresDatabaseURL(t *testing.T) {
	t.Setenv(envAPIDatabaseURL, "")
	t.Setenv(envAPIListenAddr, ":8080")
	t.Setenv(envAPIMetricsAddr, ":9090")
	if _, err := LoadAPI(); err == nil || !strings.Contains(err.Error(), envAPIDatabaseURL) {
		t.Fatalf("LoadAPI() error = %v, want missing %s", err, envAPIDatabaseURL)
	}
}
