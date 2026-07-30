package codex

import (
	"context"
	"errors"
	"testing"
)

// scriptedProbe answers ResultExists from a queue, so a test can drive
// multiple calls in sequence if a future decision ever needs more than one.
type scriptedProbe struct {
	results     []bool
	resultErr   error
	resultCalls int
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
			name:  "reports run when no result exists",
			probe: &scriptedProbe{results: []bool{false}},
			want:  ResumeRun,
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

func TestDecideFailsRatherThanGuessingWhenTheSandboxCannotBeRead(t *testing.T) {
	t.Parallel()

	sentinel := errors.New("exec into pod refused")
	probe := &scriptedProbe{results: []bool{false}, resultErr: sentinel}
	if _, err := Decide(context.Background(), probe); !errors.Is(err, sentinel) {
		t.Errorf("Decide error = %v, want it to wrap %v", err, sentinel)
	}
}
