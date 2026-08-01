package config

import "testing"

func TestLoadAgentPOCWorkerRequiresAnExplicitCredentialSecret(t *testing.T) {
	for name, value := range map[string]string{
		envAgentPOCTemporalHostPort:  "temporal:7233",
		envAgentPOCTemporalNamespace: "default",
		envAgentPOCEndpoint:          "https://chatgpt.com/backend-api/codex/responses",
		envAgentPOCAuthSecret:        "codex-auth",
		envAgentPOCPodName:           "worker-123",
		envAgentPOCPodNamespace:      "codex-agent-poc",
	} {
		t.Setenv(name, value)
	}

	config, err := LoadAgentPOCWorker()
	if err != nil {
		t.Fatalf("loading complete config: %v", err)
	}
	if config.AuthSecretName != "codex-auth" || config.PodNamespace != "codex-agent-poc" || config.TemporalHostPort != "temporal:7233" {
		t.Fatalf("config = %#v", config)
	}

	t.Setenv(envAgentPOCAuthSecret, "")
	if _, err := LoadAgentPOCWorker(); err == nil {
		t.Fatal("loading config without an explicit auth secret succeeded")
	}
}
