package workflows

import "testing"

func TestIsSubsetOf(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		a, b []string
		want bool
	}{
		{"empty a is a subset of anything", nil, []string{"x"}, true},
		{"empty a is a subset of empty b", nil, nil, true},
		{"identical sets", []string{"a", "b"}, []string{"a", "b"}, true},
		{"a is a subset of a larger b", []string{"a"}, []string{"a", "b"}, true},
		{"a is not a subset once it has something new", []string{"a", "c"}, []string{"a", "b"}, false},
		{"non-empty a against empty b is never a subset", []string{"a"}, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := isSubsetOf(tc.a, tc.b); got != tc.want {
				t.Errorf("isSubsetOf(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestIntersects(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		a, b []string
		want bool
	}{
		{"a shared id", []string{"x", "y"}, []string{"y", "z"}, true},
		{"disjoint sets", []string{"x"}, []string{"y"}, false},
		{"a is empty", nil, []string{"y"}, false},
		{"b is empty", []string{"x"}, nil, false},
		{"both empty", nil, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := intersects(tc.a, tc.b); got != tc.want {
				t.Errorf("intersects(%v, %v) = %v, want %v", tc.a, tc.b, got, tc.want)
			}
		})
	}
}
