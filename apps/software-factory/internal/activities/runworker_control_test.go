package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/store"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

type runWorkerLifecycleProbe struct {
	provisioned work.RunWorkerSpec
	material    work.RunWorkerSecretMaterial
	rotated     work.RunWorkerIdentity
	credential  work.SandboxCredential
	deleted     work.RunWorkerIdentity
	installedOn work.RunWorkerIdentity
	installedAt store.TargetAttemptID
	installed   work.Credential
	projected   work.Credential
}

func (p *runWorkerLifecycleProbe) Provision(_ context.Context, spec work.RunWorkerSpec, material work.RunWorkerSecretMaterial) (work.RunWorkerID, error) {
	p.provisioned, p.material = spec, material
	return work.RunWorkerName(spec.Identity)
}

func (p *runWorkerLifecycleProbe) RotateGitHubCredential(_ context.Context, identity work.RunWorkerIdentity, token work.Credential, login string, expiresAt time.Time) (work.RunWorkerCredentialRevision, error) {
	p.rotated = identity
	p.credential = work.SandboxCredential{Token: token, Login: login, ExpiresAt: expiresAt}
	return work.RunWorkerCredentialRevision{Revision: "2", ExpiresAt: expiresAt}, nil
}

func (p *runWorkerLifecycleProbe) InstallCheckpointCapability(_ context.Context, identity work.RunWorkerIdentity, attemptID store.TargetAttemptID, proposed work.Credential) (work.Credential, error) {
	p.installedOn, p.installedAt, p.installed = identity, attemptID, proposed
	if p.projected.Reveal() != "" {
		return p.projected, nil
	}
	return proposed, nil
}

func (p *runWorkerLifecycleProbe) Delete(_ context.Context, identity work.RunWorkerIdentity) error {
	p.deleted = identity
	return nil
}

type githubCredentialProbe struct{ credential work.SandboxCredential }

func (p githubCredentialProbe) InstallationToken(context.Context) (work.SandboxCredential, error) {
	return p.credential, nil
}

type codexCredentialProbe struct{ file work.CredentialFile }

func (p codexCredentialProbe) SandboxCredentialFile(context.Context) (work.CredentialFile, error) {
	return p.file, nil
}

type capabilityProbe struct {
	values []work.Credential
	next   int
}

func (p *capabilityProbe) Mint() (work.Credential, error) {
	if p.next >= len(p.values) {
		return work.Credential{}, errors.New("capability probe exhausted")
	}
	value := p.values[p.next]
	p.next++
	return value, nil
}

type capabilityBinderProbe struct {
	id         store.TargetAttemptID
	capability string
}

func (p *capabilityBinderProbe) BindCheckpointCapability(_ context.Context, id store.TargetAttemptID, capability string) error {
	p.id, p.capability = id, capability
	return nil
}

func runWorkerControlHarness(t *testing.T) (*RunWorkerControlActivities, *runWorkerLifecycleProbe, *capabilityProbe, *capabilityBinderProbe) {
	t.Helper()
	lifecycle := &runWorkerLifecycleProbe{}
	capabilities := &capabilityProbe{values: []work.Credential{work.NewCredential("bootstrap-secret"), work.NewCredential("attempt-secret")}}
	binder := &capabilityBinderProbe{}
	acts, err := NewRunWorkerControlActivities(RunWorkerControlDeps{
		Workers:      lifecycle,
		GitHub:       githubCredentialProbe{credential: work.SandboxCredential{Token: work.NewCredential("github-secret"), Login: "factory[bot]", ExpiresAt: time.Date(2026, 8, 1, 1, 0, 0, 0, time.UTC)}},
		Codex:        codexCredentialProbe{file: work.NewCredentialFile([]byte("codex-secret"))},
		Capabilities: capabilities,
		Binder:       binder,
		Template: RunWorkerTemplate{
			Image: "ghcr.io/example/run-worker@sha256:123", CPURequest: "2", MemoryLimit: "8Gi", DeadlineSeconds: 7200,
			Env: map[string]string{work.RunWorkerTemporalHostPortEnv: "temporal:7233"},
		},
	})
	if err != nil {
		t.Fatalf("NewRunWorkerControlActivities: %v", err)
	}
	return acts, lifecycle, capabilities, binder
}

func TestProvisionRunWorkerKeepsCredentialsInsideTheActivity(t *testing.T) {
	acts, lifecycle, _, _ := runWorkerControlHarness(t)
	in := ProvisionRunWorkerInput{TicketNumber: 42, Identity: work.RunWorkerIdentity{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", Generation: 1}, Branch: "factory/ticket-42/run"}
	out, err := acts.ProvisionRunWorker(context.Background(), in)
	if err != nil {
		t.Fatalf("ProvisionRunWorker: %v", err)
	}
	wantID, nameErr := work.RunWorkerName(in.Identity)
	if nameErr != nil {
		t.Fatal(nameErr)
	}
	if out.ID != wantID || lifecycle.provisioned.TicketNumber != 42 || lifecycle.provisioned.Image == "" || lifecycle.provisioned.Env[work.SandboxBranchEnv] != in.Branch {
		t.Fatalf("safe output/spec = %+v / %+v", out, lifecycle.provisioned)
	}
	if string(lifecycle.material.CodexCredential.Reveal()) != "codex-secret" || lifecycle.material.GitHubToken.Reveal() != "github-secret" || lifecycle.material.CheckpointCapability.Reveal() != "bootstrap-secret" {
		t.Fatal("provisioning did not receive all in-process credentials")
	}
	assertHistoryHasNoSecrets(t, in, out)
}

func TestRotateRunWorkerGitHubCredentialReturnsOnlySafeMetadata(t *testing.T) {
	acts, lifecycle, _, _ := runWorkerControlHarness(t)
	identity := work.RunWorkerIdentity{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", Generation: 1}
	out, err := acts.RotateRunWorkerGitHubCredential(context.Background(), RotateRunWorkerGitHubCredentialInput{Identity: identity})
	if err != nil {
		t.Fatalf("RotateRunWorkerGitHubCredential: %v", err)
	}
	if lifecycle.rotated != identity || lifecycle.credential.Token.Reveal() != "github-secret" || out.Revision != "2" || out.ExpiresAt.IsZero() {
		t.Fatalf("rotation = %+v / %+v", out, lifecycle.credential)
	}
	assertHistoryHasNoSecrets(t, RotateRunWorkerGitHubCredentialInput{Identity: identity}, out)
}

func TestAuthorizeRunWorkerAttemptBindsTheActuallyProjectedCapability(t *testing.T) {
	acts, lifecycle, _, binder := runWorkerControlHarness(t)
	lifecycle.projected = work.NewCredential("already-projected-secret")
	in := AuthorizeRunWorkerAttemptInput{
		Identity:  work.RunWorkerIdentity{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", Generation: 1},
		AttemptID: store.TargetAttemptID{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", StepOrdinal: 3, AttemptNo: 1},
	}
	if err := acts.AuthorizeRunWorkerAttempt(context.Background(), in); err != nil {
		t.Fatalf("AuthorizeRunWorkerAttempt: %v", err)
	}
	if lifecycle.installedAt != in.AttemptID || binder.id != in.AttemptID || binder.capability != "already-projected-secret" {
		t.Fatalf("installed/bound = %+v / %+v", lifecycle.installedAt, binder)
	}
	assertHistoryHasNoSecrets(t, in, struct{}{})
}

func TestDeleteRunWorkerDelegatesOnlyTheValidatedIdentity(t *testing.T) {
	acts, lifecycle, _, _ := runWorkerControlHarness(t)
	identity := work.RunWorkerIdentity{RunID: "0f466627-b3ae-4ba2-9c96-6ef44ec6f578", Generation: 1}
	if err := acts.DeleteRunWorker(context.Background(), DeleteRunWorkerInput{Identity: identity}); err != nil {
		t.Fatalf("DeleteRunWorker: %v", err)
	}
	if lifecycle.deleted != identity {
		t.Fatalf("deleted %+v, want %+v", lifecycle.deleted, identity)
	}
}

func assertHistoryHasNoSecrets(t *testing.T, input, output any) {
	t.Helper()
	for _, value := range []any{input, output} {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("marshal safe activity payload: %v", err)
		}
		for _, secret := range [][]byte{[]byte("codex-secret"), []byte("github-secret"), []byte("bootstrap-secret"), []byte("attempt-secret"), []byte("already-projected-secret")} {
			if bytes.Contains(raw, secret) {
				t.Fatalf("activity payload leaked credential: %s", raw)
			}
		}
	}
}
