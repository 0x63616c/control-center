package config

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
)

const (
	envAgentPOCTemporalHostPort  = "TEMPORAL_HOST_PORT"
	envAgentPOCTemporalNamespace = "TEMPORAL_NAMESPACE"
	envAgentPOCEndpoint          = "CODEX_RESPONSES_ENDPOINT"
	envAgentPOCAuthFile          = "CODEX_AUTH_FILE"
)

// AgentPOCWorker is the startup configuration for the isolated local worker.
type AgentPOCWorker struct {
	TemporalHostPort  string
	TemporalNamespace string
	ResponsesEndpoint string
	AuthFile          string
	LogLevel          slog.Level
}

// LoadAgentPOCWorker reads the POC worker environment exactly once at startup.
func LoadAgentPOCWorker() (AgentPOCWorker, error) {
	config := AgentPOCWorker{
		TemporalHostPort:  os.Getenv(envAgentPOCTemporalHostPort),
		TemporalNamespace: os.Getenv(envAgentPOCTemporalNamespace),
		ResponsesEndpoint: os.Getenv(envAgentPOCEndpoint),
		AuthFile:          os.Getenv(envAgentPOCAuthFile),
	}
	for _, required := range []struct {
		name  string
		value string
	}{
		{name: envAgentPOCTemporalHostPort, value: config.TemporalHostPort},
		{name: envAgentPOCTemporalNamespace, value: config.TemporalNamespace},
		{name: envAgentPOCEndpoint, value: config.ResponsesEndpoint},
		{name: envAgentPOCAuthFile, value: config.AuthFile},
	} {
		if strings.TrimSpace(required.value) == "" {
			return AgentPOCWorker{}, fmt.Errorf("%s is required to start the agent POC worker", required.name)
		}
	}
	level, err := logLevel()
	if err != nil {
		return AgentPOCWorker{}, err
	}
	config.LogLevel = level
	return config, nil
}
