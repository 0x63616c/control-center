package codex

import (
	"context"
	"errors"
	"testing"
)

// scriptedProbe answers from a queue, so a test can make an observation change
// between two calls — which is the whole point of the second result check.
type scriptedProbe struct {
	results     []bool
	resultErr   error
	resultCalls int

	pid      int
	alive    bool
	pidErr   error
	pidCalls int
}

func (p *scriptedProbe) ResultExists(context.Context) (bool, error) {
	if p.resultErr != nil {
		return false, p.resultErr
	}
	i := p.resultCalls
	p.resultCalls++
	if i >= len(p.results) {
		i = len(p.results) - 1
	}
	return p.results[i], nil
}

func (p *scriptedProbe) LivePID(context.Context) (int, bool, error) {
	p.pidCalls++
	if p.pidErr != nil {
		return 0, false, p.pidErr
	}
	return p.pid, p.alive, nil
}

func TestDecide(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name  string
		probe *scriptedProbe
		want  Resumption
	}{
		{
			name:  "reports done when a previous attempt left a result",
			probe: &scriptedProbe{results: []bool{true}},
			want:  ResumeDone,
		},
		{
			name:  "reports run when no attempt has started",
			probe: &scriptedProbe{results: []bool{false}, pid: 0},
			want:  ResumeRun,
		},
		{
			name:  "reports attach when an attempt is still running",
			probe: &scriptedProbe{results: []bool{false}, pid: 4242, alive: true},
			want:  ResumeAttach,
		},
		{
			name:  "reports run when an attempt died without producing a result",
			probe: &scriptedProbe{results: []bool{false, false}, pid: 4242},
			want:  ResumeRun,
		},
		{
			// The expensive case: the process finished between the first result
			// check and the liveness check. Without the second look this reads
			// as a dead attempt and pays for a full re-run.
			name:  "reports done when an attempt finished during the liveness check",
			probe: &scriptedProbe{results: []bool{false, true}, pid: 4242},
			want:  ResumeDone,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, err := Decide(context.Background(), tc.probe)
			if err != nil {
				t.Fatalf("Decide returned an unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("Decide = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestDecideSkipsTheLivenessCheckOnceAResultExists(t *testing.T) {
	t.Parallel()

	probe := &scriptedProbe{results: []bool{true}}
	if _, err := Decide(context.Background(), probe); err != nil {
		t.Fatalf("Decide returned an unexpected error: %v", err)
	}
	if probe.pidCalls != 0 {
		t.Errorf("looked for a running process %d times; a completed stage must not be probed further", probe.pidCalls)
	}
}

func TestDecideFailsRatherThanGuessingWhenTheSandboxCannotBeRead(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("exec into pod refused")

	t.Run("while checking for a result", func(t *testing.T) {
		t.Parallel()
		probe := &scriptedProbe{results: []bool{false}, resultErr: sentinel}
		if _, err := Decide(context.Background(), probe); !errors.Is(err, sentinel) {
			t.Errorf("Decide error = %v, want it to wrap %v", err, sentinel)
		}
	})

	t.Run("while checking for a running process", func(t *testing.T) {
		t.Parallel()
		probe := &scriptedProbe{results: []bool{false}, pidErr: sentinel}
		if _, err := Decide(context.Background(), probe); !errors.Is(err, sentinel) {
			t.Errorf("Decide error = %v, want it to wrap %v", err, sentinel)
		}
	})
}
