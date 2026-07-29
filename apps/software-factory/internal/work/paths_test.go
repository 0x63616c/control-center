package work

import "testing"

func TestStatusMarkerBuildsARunAndStepScopedMarker(t *testing.T) {
	t.Parallel()

	got := StatusMarker("019a3f2c-7b1e-4f9a-9c2d-3e5f6a7b8c9d", StepPickup)
	want := "<!-- software-factory:status v1 run=019a3f2c-7b1e-4f9a-9c2d-3e5f6a7b8c9d step=pickup -->"
	if got != want {
		t.Errorf("StatusMarker = %q, want %q", got, want)
	}
}

func TestStatusMarkerScopesAMarkerToOneRun(t *testing.T) {
	t.Parallel()

	if StatusMarker("run-a", StepPickup) == StatusMarker("run-b", StepPickup) {
		t.Error("two runs share a status marker; each would adopt the other's comment")
	}
}

func TestStatusMarkerGivesEveryStepOfARunItsOwnMarker(t *testing.T) {
	t.Parallel()

	// A run appends a comment per step, and each post adopts by exact marker
	// match. Two steps sharing a marker means the second post edits the first
	// step's comment instead of opening its own.
	steps := []StatusStep{StepPickup, StepOutcome}
	for _, stage := range Pipeline() {
		steps = append(steps, StageStep(stage))
	}

	seen := make(map[string]StatusStep, len(steps))
	for _, step := range steps {
		marker := StatusMarker("run-a", step)
		if other, clash := seen[marker]; clash {
			t.Errorf("steps %q and %q share the marker %q", other, step, marker)
		}
		seen[marker] = step
	}
}

func TestStageStepNamesTheStageItBelongsTo(t *testing.T) {
	t.Parallel()

	if got, want := StageStep(StageImplement), StatusStep("stage-implement"); got != want {
		t.Errorf("StageStep(StageImplement) = %q, want %q", got, want)
	}
}

func TestStatusMarkerInFindsAMarkerOnlyOnTheFirstLine(t *testing.T) {
	t.Parallel()

	marker := StatusMarker("019a3f2c", StepPickup)

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
