package config

import "testing"

func TestLoadAgentPOCWorkerRequiresAnExplicitCredentialPath(t *testing.T) {
	for name, value := range map[string]string{
		envAgentPOCTemporalHostPort:  "temporal:7233",
		envAgentPOCTemporalNamespace: "default",
		envAgentPOCEndpoint:          "https://chatgpt.com/backend-api/codex/responses",
		envAgentPOCAuthFile:          "/runtime-codex/auth.json",
	} {
		t.Setenv(name, value)
	}

	config, err := LoadAgentPOCWorker()
	if err != nil {
		t.Fatalf("loading complete config: %v", err)
	}
	if config.AuthFile != "/runtime-codex/auth.json" || config.TemporalHostPort != "temporal:7233" {
		t.Fatalf("config = %#v", config)
	}

	t.Setenv(envAgentPOCAuthFile, "")
	if _, err := LoadAgentPOCWorker(); err == nil {
		t.Fatal("loading config without an explicit auth file succeeded")
	}
}
