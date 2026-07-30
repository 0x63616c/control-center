//go:build integration

package k8s

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clock"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// The kubeconfig arrives as a flag rather than from KUBECONFIG because
// forbidigo bans os.Getenv in this module with no exclusion for test files.
var (
	kubeconfig = flag.String("kubeconfig", "", "path to a kubeconfig for the integration test's cluster")
	namespace  = flag.String("namespace", "software-factory", "namespace to create the sandbox pod in")
	image      = flag.String("sandbox-image", "", "the sandbox image to run, digest-pinned")
)

// TestSandboxRoundTripAgainstACluster covers everything the fake clientset
// cannot: client-go's fake has no pods/exec support of any kind, so every exec,
// Write and Read unit test fakes at our own streamer seam one layer below the
// API. What is asserted only here:
//
//   - that remotecommand returns utilexec.CodeExitError carrying the container's
//     real exit code, and for which failures it does not;
//   - that the WebSocket executor negotiates, and what the SPDY fallback
//     predicate does with a 403 from a partial RBAC grant;
//   - that cancelling a context stops the stream and Exec returns
//     context.Canceled — NOT, as of #434, that the remote process itself
//     dies: that guarantee depended on the pidfile shim's --kill, which is
//     deleted along with the shim (step 3 of the software-factory migration;
//     see exec.go's Exec doc comment for the accepted regression this leaves
//     until a later slice moves stage execution into the pod's own process,
//     where the embedded worker holds a real os/exec.Cmd it can kill
//     directly);
//
// The 128+N signal-kill mapping is NOT asserted here: producing a specific
// signal death needs a helper the image does not ship, and adding one only for
// a test is not worth a contract. The handling is unit-tested against a
// CodeExitError{Code: 137}.
//   - that WaitReady's readiness definition implies exec is serviceable;
//   - that the sandbox image satisfies its contract — tar, test, cat, sleep
//     infinity, and one non-root uid owning /work;
//   - that PSA baseline admits the pod spec and the Role grants enough verbs.
//
// It is not in the default `go test ./...` run and is not part of the unit
// work's definition of done. It needs the E1 sandbox image, which does not
// exist yet.
func TestSandboxRoundTripAgainstACluster(t *testing.T) {
	if *kubeconfig == "" || *image == "" {
		t.Skip("needs -kubeconfig and -sandbox-image")
	}

	cfg, err := clientcmd.BuildConfigFromFlags("", *kubeconfig)
	if err != nil {
		t.Fatalf("building the client config: %v", err)
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatalf("building the clientset: %v", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
	s, err := newSandboxes(cs, newRemoteStreamer(cfg, cs.CoreV1().RESTClient(), *namespace, logger),
		*namespace, logger, clock.System{})
	if err != nil {
		t.Fatalf("constructing Sandboxes: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	spec := work.SandboxSpec{
		TicketNumber:    999999,
		RunID:           "integration",
		Image:           *image,
		CPULimit:        "500m",
		MemoryLimit:     "512Mi",
		DeadlineSeconds: 600,
		Env:             map[string]string{"CODEX_HOME": "/work/.codex"},
	}

	credential := work.NewCredentialFile([]byte(`{"tokens":{"access_token":"integration-test"}}`))
	sandbox, err := s.Create(ctx, spec, credential)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	t.Cleanup(func() {
		if err := s.Delete(context.WithoutCancel(ctx), sandbox); err != nil {
			t.Errorf("Delete: %v", err)
		}
	})

	if err := s.WaitReady(ctx, sandbox); err != nil {
		t.Fatalf("WaitReady: %v", err)
	}

	t.Run("adopts its own create retry", func(t *testing.T) {
		got, err := s.Create(ctx, spec, credential)
		if err != nil {
			t.Fatalf("Create (retry): %v", err)
		}
		if got != sandbox {
			t.Errorf("Create (retry) = %q, want the adopted %q", got, sandbox)
		}
	})

	const secretPath = work.SandboxRoot + "/integration/nested/creds"
	t.Run("writes a file with its mode and reads it back", func(t *testing.T) {
		if err := s.Write(ctx, sandbox, secretPath, []byte("token"), 0o600); err != nil {
			t.Fatalf("Write: %v", err)
		}
		got, err := s.Read(ctx, sandbox, secretPath)
		if err != nil {
			t.Fatalf("Read: %v", err)
		}
		if string(got) != "token" {
			t.Errorf("Read = %q, want %q", got, "token")
		}
		// The mode survived extraction, and the parents are traversable.
		var out bytes.Buffer
		code, err := s.Exec(ctx, sandbox, []string{"stat", "-c", "%a", secretPath}, nil, &out, os.Stderr)
		if err != nil || code != 0 {
			t.Fatalf("stat: code %d, err %v", code, err)
		}
		if strings.TrimSpace(out.String()) != "600" {
			t.Errorf("mode on disk = %q, want 600", strings.TrimSpace(out.String()))
		}
	})

	t.Run("reports a missing file as ErrFileNotFound", func(t *testing.T) {
		_, err := s.Read(ctx, sandbox, work.SandboxRoot+"/integration/absent")
		if !errors.Is(err, work.ErrFileNotFound) {
			t.Errorf("Read error = %v, want work.ErrFileNotFound", err)
		}
	})

	t.Run("returns a real non-zero exit code", func(t *testing.T) {
		// The whole stage success/failure signal rests on this, and only a real
		// apiserver shows whether the error stream's metav1.Status becomes a
		// CodeExitError. argv-only, so no shell is needed to produce the code:
		// the sandbox image ships none, deliberately.
		code, err := s.Exec(ctx, sandbox, []string{"test", "-e", "/definitely/not/here"}, nil, os.Stderr, os.Stderr)
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
		if code != 1 {
			t.Errorf("exit code = %d, want 1", code)
		}
	})

	t.Run("reports a missing binary as exit 127", func(t *testing.T) {
		code, err := s.Exec(ctx, sandbox, []string{"definitely-not-a-command"}, nil, os.Stderr, os.Stderr)
		if err != nil {
			t.Fatalf("Exec: %v", err)
		}
		if code != 127 {
			t.Errorf("exit code = %d, want 127", code)
		}
	})

	t.Run("stops the stream on cancellation", func(t *testing.T) {
		// Since #434 this only asserts what Exec's own doc comment still
		// promises: the stream tears down and the caller sees
		// context.Canceled. It does NOT assert the remote process dies —
		// that depended on the deleted pidfile shim's --kill, and is an
		// accepted regression until a later slice moves stage execution
		// into the pod's own process (see exec.go).
		runCtx, stop := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() {
			_, err := s.Exec(runCtx, sandbox, []string{"sleep", "600"}, nil, os.Stderr, os.Stderr)
			done <- err
		}()
		time.Sleep(2 * time.Second)
		stop()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("Exec error = %v, want context.Canceled", err)
		}
	})
}
