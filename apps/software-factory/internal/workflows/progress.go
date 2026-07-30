package workflows

// isSubsetOf reports whether every element of a appears in b.
//
// This is rule 1 of the implement/review loop's progress detection
// (pipeline-rewrite spec, "The real stop condition"): the same failing CI
// check(s) surviving an intervening implement turn, with nothing new having
// appeared, is terminal. A CI turn that fails a DIFFERENT check than the
// last observed one is progress — something got fixed even if something
// else broke — and the caller only invokes this when a is non-empty, so an
// empty a is never itself read as a stall by anything in this package; this
// function stays total (an empty a is trivially a subset of anything) so it
// needs no separate zero-length case at its call site.
func isSubsetOf(a, b []string) bool {
	set := make(map[string]struct{}, len(b))
	for _, x := range b {
		set[x] = struct{}{}
	}
	for _, x := range a {
		if _, ok := set[x]; !ok {
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
