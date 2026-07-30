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
