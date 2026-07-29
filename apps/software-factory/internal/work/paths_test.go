package work

import (
	"strings"
	"testing"
)

func TestStatusMarkerBuildsARunScopedMarker(t *testing.T) {
	t.Parallel()

	got := StatusMarker("019a3f2c-7b1e-4f9a-9c2d-3e5f6a7b8c9d")
	want := "<!-- software-factory:status v1 run=019a3f2c-7b1e-4f9a-9c2d-3e5f6a7b8c9d -->"
	if got != want {
		t.Errorf("StatusMarker = %q, want %q", got, want)
	}
}

func TestStatusMarkerScopesAMarkerToOneRun(t *testing.T) {
	t.Parallel()

	if StatusMarker("run-a") == StatusMarker("run-b") {
		t.Error("two runs share a status marker; each would adopt the other's comment")
	}
}

func TestStatusMarkerInFindsAMarkerOnlyOnTheFirstLine(t *testing.T) {
	t.Parallel()

	marker := StatusMarker("019a3f2c")

	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "a rendered status body opens with its marker",
			body: marker + "\n### software factory — implementing\n",
			want: marker,
		},
		{
			name: "a body that is nothing but the marker",
			body: marker,
			want: marker,
		},
		{
			// A human quoting a status comment reproduces the marker further
			// down. Matching it would let a run adopt a comment it did not
			// write and edit someone else's words.
			name: "marker-shaped text below the first line is not a marker",
			body: "look what the bot wrote:\n" + marker + "\n",
			want: "",
		},
		{
			name: "an ordinary comment carries no marker",
			body: "please also handle the empty case",
			want: "",
		},
		{
			name: "an empty body carries no marker",
			body: "",
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got, ok := StatusMarkerIn(tc.body)
			if ok != (tc.want != "") {
				t.Fatalf("StatusMarkerIn ok = %v, want %v", ok, tc.want != "")
			}
			if got != tc.want {
				t.Errorf("StatusMarkerIn = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRepoDirIsInsideTheSandboxRootWithoutBeingIt(t *testing.T) {
	// Inside, because transfer.go confines every write to the sandbox root.
	// Not equal to it, because the run's own scaffolding lives at the root and
	// a checkout over the top of that puts prompts inside the git working tree.
	if !strings.HasPrefix(RepoDir, SandboxRoot+"/") {
		t.Errorf("RepoDir = %q, want a path under %q", RepoDir, SandboxRoot)
	}
	if RepoDir == SandboxRoot {
		t.Errorf("RepoDir must not be the sandbox root itself: %q", RepoDir)
	}
}

func TestStageScaffoldingIsNotInsideTheCheckout(t *testing.T) {
	// The reason RepoDir is a sibling of the scaffolding rather than its parent:
	// anything under the checkout is untracked content in the working tree that
	// `implement` could commit into the branch it pushes.
	paths := StageKey{Ticket: 1, RunID: "run", Stage: StagePlan}.Paths()
	if strings.HasPrefix(paths.Dir, RepoDir+"/") {
		t.Errorf("stage dir %q is inside the checkout %q", paths.Dir, RepoDir)
	}
}
