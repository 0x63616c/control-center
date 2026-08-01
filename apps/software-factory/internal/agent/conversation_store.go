package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
)

// ConversationStore persists immutable, content-addressed conversation revisions.
type ConversationStore struct {
	blobs blobs.Store
}

// NewConversationStore constructs a conversation store over the shared blob service.
func NewConversationStore(store blobs.Store) ConversationStore {
	return ConversationStore{blobs: store}
}

// Append stores one new revision below identity.
func (store ConversationStore) Append(
	ctx context.Context,
	identity string,
	predecessor *ConversationRef,
	items []ConversationItem,
) (ConversationRef, error) {
	revision := 0
	if predecessor != nil {
		revision = predecessor.Revision + 1
	}
	record := ConversationRevision{Predecessor: predecessor, Items: items}
	encoded, err := json.Marshal(record)
	if err != nil {
		return ConversationRef{}, fmt.Errorf("encode conversation revision %d: %w", revision, err)
	}
	digestBytes := sha256.Sum256(encoded)
	digest := hex.EncodeToString(digestBytes[:])
	key, err := blobs.NewKey(blobs.BucketConversations, fmt.Sprintf("%s/%d/%s", identity, revision, digest))
	if err != nil {
		return ConversationRef{}, fmt.Errorf("name conversation revision %d: %w", revision, err)
	}
	if err := store.blobs.Put(ctx, key, encoded); err != nil {
		return ConversationRef{}, fmt.Errorf("store conversation revision %d: %w", revision, err)
	}
	return ConversationRef{Key: key.String(), Revision: revision, Bytes: int64(len(encoded)), Digest: digest}, nil
}

// Load reads and verifies one immutable conversation revision.
func (store ConversationStore) Load(ctx context.Context, ref ConversationRef) (ConversationRevision, error) {
	key, err := blobs.ParseKey(ref.Key)
	if err != nil {
		return ConversationRevision{}, fmt.Errorf("load conversation revision %d: %w", ref.Revision, err)
	}
	encoded, err := store.blobs.Get(ctx, key)
	if err != nil {
		return ConversationRevision{}, fmt.Errorf("load conversation revision %d: %w", ref.Revision, err)
	}
	actualDigest := sha256.Sum256(encoded)
	if hex.EncodeToString(actualDigest[:]) != ref.Digest {
		return ConversationRevision{}, fmt.Errorf("load conversation revision %d: digest mismatch", ref.Revision)
	}
	if int64(len(encoded)) != ref.Bytes {
		return ConversationRevision{}, fmt.Errorf("load conversation revision %d: byte count mismatch", ref.Revision)
	}
	var revision ConversationRevision
	if err := json.Unmarshal(encoded, &revision); err != nil {
		return ConversationRevision{}, fmt.Errorf("decode conversation revision %d: %w", ref.Revision, err)
	}
	return revision, nil
}
