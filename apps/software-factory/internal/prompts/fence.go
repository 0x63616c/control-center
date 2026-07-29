package prompts

import (
	"encoding/hex"
	"fmt"
	"io"
	"strings"
)

// fenceTag opens and closes the region of a prompt holding the issue's own
// words. The nonce is appended to it, so the tags a prompt actually carries are
// `<untrusted-issue-text-7f3a91…>` and its closing form.
//
// The tag alone would be a fixed literal, and a fixed literal is one an issue
// body can write. Text after a forged closing tag lands as un-fenced prose
// immediately before "Your instructions for this stage follow" — the most
// authoritative position in the prompt. The nonce is what makes the closing tag
// unwritable by anyone who has not seen this run's prompt.
const fenceTag = "untrusted-issue-text-"

// strippedMarker replaces a nonce found in untrusted text.
//
// It is not the empty string, and that is load-bearing twice over. Deleting the
// nonce would let the characters either side close up into a fresh copy of it —
// "abc" + nonce + "def" written as nonce[:3] + nonce + nonce[3:] reassembles
// the moment the middle is removed — and a non-empty replacement keeps them
// apart. It is also visible: an injection attempt that vanished silently is one
// nobody reviewing the transcript can see was made.
const strippedMarker = "[fence marker removed]"

// nonceBytes is the entropy behind one run's fence. Sixteen hex characters:
// long enough that guessing is hopeless, short enough that the tag still reads
// as a tag.
const nonceBytes = 8

// mintNonce draws one run's fence nonce from the injected entropy source.
//
// Hex, so the value is safe in a tag name whatever the bytes say, and so a
// human comparing two prompts can see at a glance that the nonce changed.
func mintNonce(entropy io.Reader) (string, error) {
	raw := make([]byte, nonceBytes)
	if _, err := io.ReadFull(entropy, raw); err != nil {
		return "", fmt.Errorf("drawing a fence nonce: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

// strip removes every occurrence of this run's nonce from text nobody trusts.
//
// Whoever filed the issue chooses its title, body and comments, and whoever
// commented chooses a comment; a document from an earlier stage may quote any
// of them. If the nonce ever leaks — a transcript, a prompt echoed back in a
// document — this is what stops the leak becoming a forged fence. Without it
// the nonce buys nothing the fixed tag did not.
//
// One pass suffices: the replacement contains no part of the nonce, so it
// separates whatever text surrounded a match rather than joining it.
func strip(text, nonce string) string {
	return strings.ReplaceAll(text, nonce, strippedMarker)
}

// checkFence asserts that the rendered prompt's nonce is in the fence tags and
// nowhere else.
//
// It is the invariant the whole fence rests on, checked mechanically rather
// than trusted to strip's callers: a value interpolated without being stripped
// is one edit away at any time, and this is what turns that edit into a failed
// render instead of a forgeable prompt. Correctness over operability — a stage
// that does not run beats a stage that runs on an attacker's instructions.
func checkFence(rendered, nonce string) error {
	if !strings.Contains(rendered, "<"+fenceTag+nonce+">") {
		return fmt.Errorf("the rendered prompt does not open the untrusted-text fence")
	}
	if !strings.Contains(rendered, "</"+fenceTag+nonce+">") {
		return fmt.Errorf("the rendered prompt does not close the untrusted-text fence")
	}
	if got := strings.Count(rendered, nonce); got != 2 {
		return fmt.Errorf("the fence nonce appears %d times in the rendered prompt, want 2: some interpolated text was not stripped and the fence can be forged", got)
	}
	return nil
}
