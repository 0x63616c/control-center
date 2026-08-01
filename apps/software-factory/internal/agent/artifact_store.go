package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
)

// ArtifactStore persists content-addressed agent artifacts outside Temporal history.
type ArtifactStore struct {
	blobs blobs.Store
}

// NewArtifactStore constructs an artifact store over the shared blob service.
func NewArtifactStore(store blobs.Store) ArtifactStore {
	return ArtifactStore{blobs: store}
}

// StoreText persists immutable final text below a workflow identity.
func (store ArtifactStore) StoreText(ctx context.Context, identity, value string) (TextRef, error) {
	ref, err := store.put(ctx, identity, "text", []byte(value))
	return TextRef(ref), err
}

// LoadText verifies and loads immutable final text.
func (store ArtifactStore) LoadText(ctx context.Context, ref TextRef) (string, error) {
	value, err := store.get(ctx, ArtifactRef(ref))
	if err != nil {
		return "", err
	}
	return string(value), nil
}

// StoreArguments persists immutable provider tool arguments below a workflow identity.
func (store ArtifactStore) StoreArguments(ctx context.Context, identity string, value []byte) (ArgumentsRef, error) {
	ref, err := store.put(ctx, identity, "arguments", value)
	return ArgumentsRef(ref), err
}

// LoadArguments verifies and loads immutable provider tool arguments.
func (store ArtifactStore) LoadArguments(ctx context.Context, ref ArgumentsRef) ([]byte, error) {
	return store.get(ctx, ArtifactRef(ref))
}

func (store ArtifactStore) put(ctx context.Context, identity, kind string, value []byte) (ArtifactRef, error) {
	digestBytes := sha256.Sum256(value)
	digest := hex.EncodeToString(digestBytes[:])
	key, err := blobs.NewKey(blobs.BucketConversations, fmt.Sprintf("%s/artifacts/%s/%s", identity, kind, digest))
	if err != nil {
		return ArtifactRef{}, fmt.Errorf("name agent %s artifact: %w", kind, err)
	}
	if err := store.blobs.Put(ctx, key, value); err != nil {
		return ArtifactRef{}, fmt.Errorf("store agent %s artifact: %w", kind, err)
	}
	return ArtifactRef{Key: key.String(), Bytes: int64(len(value)), Digest: digest}, nil
}

func (store ArtifactStore) get(ctx context.Context, ref ArtifactRef) ([]byte, error) {
	key, err := blobs.ParseKey(ref.Key)
	if err != nil {
		return nil, fmt.Errorf("parse agent artifact reference: %w", err)
	}
	if key.Bucket != blobs.BucketConversations {
		return nil, fmt.Errorf("agent artifact key %q is in the wrong bucket", key)
	}
	value, err := store.blobs.Get(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("load agent artifact %q: %w", key, err)
	}
	digestBytes := sha256.Sum256(value)
	if hex.EncodeToString(digestBytes[:]) != ref.Digest {
		return nil, fmt.Errorf("load agent artifact %q: digest mismatch", key)
	}
	if int64(len(value)) != ref.Bytes {
		return nil, fmt.Errorf("load agent artifact %q: byte count mismatch", key)
	}
	return value, nil
}
