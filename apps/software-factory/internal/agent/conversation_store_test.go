package agent_test

import (
	"reflect"
	"testing"

	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/agent"
	"github.com/0x63616c/world-wide-webb/apps/software-factory/internal/blobs"
)

func TestConversationStoreAppendsAnImmutableRevision(t *testing.T) {
	t.Parallel()

	store := agent.NewConversationStore(blobs.NewMemStore())
	wantItems := []agent.ConversationItem{{Kind: agent.ItemUserText, Text: "Design this."}}

	ref, err := store.Append(t.Context(), "agent/run-7/plan", nil, wantItems)
	if err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	const digest = "7eadfb8fa56569fd694db3cb9dd5ff9ec13a96278f2d0553c9faee3b5c39609b"
	wantRef := agent.ConversationRef{
		Key:      "conversations/agent/run-7/plan/0/" + digest,
		Revision: 0,
		Bytes:    73,
		Digest:   digest,
	}
	if ref != wantRef {
		t.Fatalf("Append() ref = %+v, want %+v", ref, wantRef)
	}

	loaded, err := store.Load(t.Context(), ref)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if loaded.Predecessor != nil || !reflect.DeepEqual(loaded.Items, wantItems) {
		t.Fatalf("Load() revision = %+v", loaded)
	}

	wantItems[0].Text = "mutated by caller"
	loadedAgain, err := store.Load(t.Context(), ref)
	if err != nil {
		t.Fatalf("second Load() error = %v", err)
	}
	if loadedAgain.Items[0].Text != "Design this." {
		t.Fatalf("stored text = %q, want immutable original", loadedAgain.Items[0].Text)
	}
}
