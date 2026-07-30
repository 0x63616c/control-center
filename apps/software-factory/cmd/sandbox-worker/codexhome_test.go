package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestEnsureCodexHomeCreatesAWritableDirAndSymlinksTheMountedCredential
// reproduces the fix for prod run one (#434): mounting the credential Secret
// directly at authFile made Kubernetes, not the sandbox uid, own homeDir —
// and codex needs to write other files there too. This proves both halves:
// the directory this process creates is one it can write into, and the
// credential is reachable through it exactly as codex expects.
func TestEnsureCodexHomeCreatesAWritableDirAndSymlinksTheMountedCredential(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	home := filepath.Join(dir, ".codex")
	authFile := filepath.Join(home, "auth.json")
	mountFile := filepath.Join(dir, "mounted-secret", "auth.json")

	if err := os.MkdirAll(filepath.Dir(mountFile), 0o755); err != nil {
		t.Fatalf("staging the mounted secret: %v", err)
	}
	if err := os.WriteFile(mountFile, []byte(`{"ok":true}`), 0o440); err != nil {
		t.Fatalf("staging the mounted secret: %v", err)
	}

	if err := ensureCodexHome(home, authFile, mountFile); err != nil {
		t.Fatalf("ensureCodexHome: %v", err)
	}

	info, err := os.Stat(home)
	if err != nil {
		t.Fatalf("stat home: %v", err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Errorf("home dir mode = %v, want 0700 — must be writable by the uid that created it, not a subPath mount's default root:root 0755", info.Mode().Perm())
	}

	target, err := os.Readlink(authFile)
	if err != nil {
		t.Fatalf("readlink authFile: %v", err)
	}
	if target != mountFile {
		t.Errorf("symlink target = %q, want %q", target, mountFile)
	}

	got, err := os.ReadFile(authFile)
	if err != nil {
		t.Fatalf("reading through the symlink: %v", err)
	}
	if string(got) != `{"ok":true}` {
		t.Errorf("read %q through the symlink, want the mounted secret's own bytes", got)
	}

	// The whole point: a directory this process created for itself, writable
	// by its own uid, really can hold the other files codex needs beside
	// auth.json — exactly what a Secret-owned CodexHomeDir refused with
	// "Permission denied (os error 13)" in prod run one.
	if err := os.WriteFile(filepath.Join(home, "aliases"), []byte("x"), 0o600); err != nil {
		t.Fatalf("writing beside the credential: %v — this is exactly the permission error prod run one hit", err)
	}
}

// TestEnsureCodexHomeIsIdempotent proves a second call — which nothing in
// this pod's single-run lifecycle makes today, but which costs nothing to
// guarantee — finds its own symlink already in place and returns nil rather
// than erroring on "file exists".
func TestEnsureCodexHomeIsIdempotent(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	home := filepath.Join(dir, ".codex")
	authFile := filepath.Join(home, "auth.json")
	mountFile := filepath.Join(dir, "mounted-secret", "auth.json")

	if err := os.MkdirAll(filepath.Dir(mountFile), 0o755); err != nil {
		t.Fatalf("staging the mounted secret: %v", err)
	}
	if err := os.WriteFile(mountFile, []byte(`{}`), 0o440); err != nil {
		t.Fatalf("staging the mounted secret: %v", err)
	}

	if err := ensureCodexHome(home, authFile, mountFile); err != nil {
		t.Fatalf("first call: %v", err)
	}
	if err := ensureCodexHome(home, authFile, mountFile); err != nil {
		t.Fatalf("second call must be a no-op, not an error: %v", err)
	}
}

// TestEnsureCodexHomeRefusesToClobberAnUnexpectedAuthFile proves a
// pre-existing, non-symlink authFile is left alone rather than silently
// replaced — if something else ever put a real file there, that is worth
// failing loudly over, not overwriting.
func TestEnsureCodexHomeRefusesToClobberAnUnexpectedAuthFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	home := filepath.Join(dir, ".codex")
	authFile := filepath.Join(home, "auth.json")
	mountFile := filepath.Join(dir, "mounted-secret", "auth.json")

	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatalf("staging home: %v", err)
	}
	if err := os.WriteFile(authFile, []byte("not a symlink"), 0o600); err != nil {
		t.Fatalf("staging authFile: %v", err)
	}

	if err := ensureCodexHome(home, authFile, mountFile); err == nil {
		t.Fatal("a pre-existing, non-symlink auth.json must not be silently replaced")
	}
}
