package codexauth_test

import (
	"context"
	"errors"
	"maps"
	"strconv"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/clients/codexauth"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/work"
)

// fakeStore is the compare-and-swap the real Secret gets from the apiserver,
// with a counter standing in for a resourceVersion. It exists to prove the seam
// can express a lease at all: a store that cannot refuse a stale write cannot
// be one.
type fakeStore struct {
	values  map[string][]byte
	version int
}

func newFakeStore(seed map[string][]byte) *fakeStore {
	values := make(map[string][]byte, len(seed))
	maps.Copy(values, seed)
	return &fakeStore{values: values, version: 1}
}

func (s *fakeStore) Get(context.Context) (map[string][]byte, work.SecretVersion, error) {
	return maps.Clone(s.values), work.ObservedVersion(strconv.Itoa(s.version)), nil
}

func (s *fakeStore) Put(_ context.Context, values map[string][]byte, precondition work.SecretVersion) (work.SecretVersion, error) {
	if precondition.IsZero() {
		return work.SecretVersion{}, errors.New("refusing a write with no precondition")
	}
	if !precondition.IsUnconditional() && precondition.Token() != strconv.Itoa(s.version) {
		return work.SecretVersion{}, work.ErrVersionConflict
	}
	maps.Copy(s.values, values)
	s.version++
	return work.ObservedVersion(strconv.Itoa(s.version)), nil
}

var _ codexauth.SecretStore = (*fakeStore)(nil)

func TestAStaleWriteIsRefusedRatherThanAppliedOverAConcurrentOne(t *testing.T) {
	t.Parallel()

	store := newFakeStore(map[string][]byte{"auth.json": []byte("seed")})
	ctx := context.Background()

	_, stale, err := store.Get(ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, err := store.Put(ctx, map[string][]byte{"auth.json": []byte("theirs")}, stale); err != nil {
		t.Fatalf("the first write at a current version: %v", err)
	}

	// The stored refresh token is single-use, so a silently applied stale write
	// is not a lost update but a dead credential.
	if _, err := store.Put(ctx, map[string][]byte{"auth.json": []byte("ours")}, stale); !errors.Is(err, work.ErrVersionConflict) {
		t.Fatalf("a write at a superseded version returned %v, want a version conflict", err)
	}
}

func TestAWriteChainsFromTheVersionItProduced(t *testing.T) {
	t.Parallel()

	store := newFakeStore(nil)
	ctx := context.Background()

	_, version, err := store.Get(ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	// Re-reading between the lease write and the write it protects would adopt
	// whatever landed in between as the precondition — which is the lease's own
	// linearization point, given away.
	next, err := store.Put(ctx, map[string][]byte{"lease": []byte("held")}, version)
	if err != nil {
		t.Fatalf("taking the lease: %v", err)
	}
	if _, err := store.Put(ctx, map[string][]byte{"auth.json": []byte("rotated")}, next); err != nil {
		t.Fatalf("settling at the version the lease write produced: %v", err)
	}
}

func TestEveryKeyOfAWriteLandsTogether(t *testing.T) {
	t.Parallel()

	store := newFakeStore(map[string][]byte{"auth.json": []byte("old"), "keep": []byte("kept")})
	ctx := context.Background()

	_, version, err := store.Get(ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, err := store.Put(ctx, map[string][]byte{
		"auth.json": []byte("rotated"),
		"lease":     []byte("cleared"),
	}, version); err != nil {
		t.Fatalf("Put: %v", err)
	}

	values, _, err := store.Get(ctx)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	for key, want := range map[string]string{"auth.json": "rotated", "lease": "cleared", "keep": "kept"} {
		if got := string(values[key]); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}
