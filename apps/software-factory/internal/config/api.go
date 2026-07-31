package config

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
)

const (
	envAPIDatabaseURL = "SOFTWARE_FACTORY_DATABASE_URL"
	envAPIListenAddr  = "API_ADDR"
	envAPIMetricsAddr = "METRICS_ADDR"
)

// API is the parsed startup configuration for the factory API process.
type API struct {
	DatabaseURL string
	ListenAddr  string
	MetricsAddr string
	LogLevel    slog.Level
}

// LoadAPI parses all API process configuration before any external work begins.
func LoadAPI() (API, error) {
	cfg := API{
		DatabaseURL: os.Getenv(envAPIDatabaseURL),
		ListenAddr:  os.Getenv(envAPIListenAddr),
		MetricsAddr: os.Getenv(envAPIMetricsAddr),
	}
	for name, value := range map[string]string{
		envAPIDatabaseURL: cfg.DatabaseURL,
		envAPIListenAddr:  cfg.ListenAddr,
		envAPIMetricsAddr: cfg.MetricsAddr,
	} {
		if strings.TrimSpace(value) == "" {
			return API{}, fmt.Errorf("%s is required to start the API", name)
		}
	}
	level, err := logLevel()
	if err != nil {
		return API{}, err
	}
	cfg.LogLevel = level
	return cfg, nil
}
