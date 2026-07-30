package workflows

import "github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"

// sameCheckFailures reports whether a and b identify exactly the same failed
// check runs, independent of their order.
//
// This is rule 1 of the implement/review loop's progress detection: a strict
// subset is evidence of progress, as is a same-named check with a different
// fingerprint. The caller only invokes this when a is non-empty.
func sameCheckFailures(a, b []work.CheckFailure) bool {
	aSet := make(map[work.CheckFailure]struct{}, len(a))
	for _, failure := range a {
		aSet[failure] = struct{}{}
	}
	bSet := make(map[work.CheckFailure]struct{}, len(b))
	for _, x := range b {
		bSet[x] = struct{}{}
	}
	if len(aSet) != len(bSet) {
		return false
	}
	for failure := range aSet {
		if _, ok := bSet[failure]; !ok {
			return false
		}
	}
	return true
}

// sameCheckNamesSubset preserves the pre-failure-fingerprint version of rule
// 1 for histories that recorded the old command path. Keep it until no
// retained WorkTicket history can replay that version.
func sameCheckNamesSubset(a, b []work.CheckFailure) bool {
	set := make(map[string]struct{}, len(b))
	for _, failure := range b {
		set[failure.Name] = struct{}{}
	}
	for _, failure := range a {
		if _, ok := set[failure.Name]; !ok {
			return false
		}
	}
	return true
}

// intersects reports whether a and b share at least one element.
//
// This is rule 2: the same blocking review finding id held across two
// review turns. A review turn that raises only new blocking findings, with
// none surviving from before, does not trip it.
func intersects(a, b []string) bool {
	set := make(map[string]struct{}, len(b))
	for _, x := range b {
		set[x] = struct{}{}
	}
	for _, x := range a {
		if _, ok := set[x]; ok {
			return true
		}
	}
	return false
}
