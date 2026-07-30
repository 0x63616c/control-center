package github

import (
	"net/http"
	"testing"
)

func TestChecksForRefFingerprintsFailedOutputAndEveryAnnotation(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/commits/"+testBranch+"/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"check_runs": []map[string]any{{
			"id": 91, "name": "test-software-factory", "status": "completed", "conclusion": "failure",
			"output": map[string]any{"title": "tests failed", "summary": "one assertion", "text": "details"},
		}}})
	})
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/check-runs/91/annotations", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "2" {
			writeJSON(w, http.StatusOK, []map[string]any{{"path": "b_test.go", "start_line": 8, "end_line": 8, "annotation_level": "failure", "message": "second"}})
			return
		}
		w.Header().Set("Link", "<"+s.URL+"/repos/"+testOwner+"/"+testRepo+"/check-runs/91/annotations?page=2>; rel=\"next\"")
		writeJSON(w, http.StatusOK, []map[string]any{{"path": "a_test.go", "start_line": 4, "end_line": 4, "annotation_level": "failure", "message": "first"}})
	})
	c, _ := s.client(t)

	checks, err := c.ChecksForRef(t.Context(), testBranch)
	if err != nil {
		t.Fatalf("ChecksForRef: %v", err)
	}
	if len(checks) != 1 || checks[0].Name != "test-software-factory" || checks[0].FailureFingerprint == "" {
		t.Fatalf("checks = %+v, want one failed, fingerprinted check", checks)
	}
	again, err := c.ChecksForRef(t.Context(), testBranch)
	if err != nil {
		t.Fatalf("second ChecksForRef: %v", err)
	}
	if again[0].FailureFingerprint != checks[0].FailureFingerprint {
		t.Fatalf("fingerprint changed between equivalent snapshots: %q then %q", checks[0].FailureFingerprint, again[0].FailureFingerprint)
	}
	if s.count("GET /repos/"+testOwner+"/"+testRepo+"/check-runs/91/annotations") != 4 {
		t.Fatalf("annotation requests = %d, want both pages for each snapshot; saw %s", s.count("GET /repos/"+testOwner+"/"+testRepo+"/check-runs/91/annotations"), s)
	}
}

func TestChecksForRefRejectsAPartialAnnotationSnapshot(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/commits/"+testBranch+"/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"check_runs": []map[string]any{{
			"id": 91, "name": "test-software-factory", "status": "completed", "conclusion": "failure",
		}}})
	})
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/check-runs/91/annotations", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusInternalServerError, "annotation service unavailable")
	})
	c, _ := s.client(t)

	if _, err := c.ChecksForRef(t.Context(), testBranch); err == nil {
		t.Fatal("ChecksForRef returned a partial check snapshot after annotation retrieval failed")
	}
}

func TestChecksForRefLeavesGenericGitHubActionsFailuresUnfingerprinted(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/commits/"+testBranch+"/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"check_runs": []map[string]any{{
			"id": 91, "name": "test-software-factory", "status": "completed", "conclusion": "failure",
		}}})
	})
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/check-runs/91/annotations", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []map[string]any{{
			"path": ".github", "annotation_level": "failure", "message": "Process completed with exit code 1.",
		}})
	})
	c, _ := s.client(t)

	checks, err := c.ChecksForRef(t.Context(), testBranch)
	if err != nil {
		t.Fatalf("ChecksForRef: %v", err)
	}
	if len(checks) != 1 || checks[0].FailureFingerprint != "" {
		t.Fatalf("checks = %+v, want a failed check without a false failure identity", checks)
	}
}

func TestChecksForRefFingerprintsGenericGitHubActionsFailuresFromTestLogs(t *testing.T) {
	t.Parallel()

	s, _ := newStub(t)
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/commits/"+testBranch+"/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"check_runs": []map[string]any{{
			"id": 91, "name": "test-software-factory", "status": "completed", "conclusion": "failure",
			"details_url": s.URL + "/" + testOwner + "/" + testRepo + "/actions/runs/100/job/91",
		}}})
	})
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/check-runs/91/annotations", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []map[string]any{{
			"path": ".github", "annotation_level": "failure", "message": "Process completed with exit code 1.",
		}})
	})
	s.handle("GET /repos/"+testOwner+"/"+testRepo+"/actions/jobs/91/logs", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", s.URL+"/job-91.log")
		w.WriteHeader(http.StatusFound)
	})
	s.handle("GET /job-91.log", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("2026-07-30T21:00:00Z --- FAIL: TestWorkTicketContinuesWhenTheSameCheckHasAnotherFailure (0.00s)\n"))
	})
	c, _ := s.client(t)

	checks, err := c.ChecksForRef(t.Context(), testBranch)
	if err != nil {
		t.Fatalf("ChecksForRef: %v", err)
	}
	if len(checks) != 1 || checks[0].FailureFingerprint == "" {
		t.Fatalf("checks = %+v, want the failing Go test identity from the Actions log", checks)
	}
}

func TestFailedGoTestsQualifiesSameNamedTestsByPackage(t *testing.T) {
	t.Parallel()

	pkgA := "2026-07-30T21:00:00Z --- FAIL: TestValidate (0.00s)\n" +
		"2026-07-30T21:00:00Z FAIL\n" +
		"2026-07-30T21:00:00Z FAIL\tgithub.com/0x63616c/world-wide-webb/pkg/a\t0.01s\n"
	pkgB := "2026-07-30T21:00:00Z --- FAIL: TestValidate (0.00s)\n" +
		"2026-07-30T21:00:00Z FAIL\n" +
		"2026-07-30T21:00:00Z FAIL\tgithub.com/0x63616c/world-wide-webb/pkg/b\t0.01s\n"

	testsA := failedGoTests(pkgA)
	testsB := failedGoTests(pkgB)
	if len(testsA) != 1 || len(testsB) != 1 || testsA[0] == testsB[0] {
		t.Fatalf("failedGoTests(pkgA) = %v, failedGoTests(pkgB) = %v, want distinct package-qualified identities", testsA, testsB)
	}
}

func TestFailedGoTestsFallsBackToBareNameWithoutAPackageSummaryLine(t *testing.T) {
	t.Parallel()

	tests := failedGoTests("2026-07-30T21:00:00Z --- FAIL: TestTruncated (0.00s)\n")
	if len(tests) != 1 || tests[0] != "TestTruncated" {
		t.Fatalf("failedGoTests = %v, want the bare test name when no summary line was logged", tests)
	}
}
