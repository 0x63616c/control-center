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
// authoritative position in the prompt. Two things stop that: strip removes any
// tag-shaped string from untrusted text, so the literal cannot be written at
// all, and the nonce means that even a tag reconstructed some way strip cannot
// see does not match the one the model was shown.
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

// strip removes every tag-shaped string from text nobody trusts: this run's
// nonce, and the tag name itself.
//
// Whoever filed the issue chooses its title, body and comments, and whoever
// commented chooses a comment; a document from an earlier stage may quote any
// of them. If the nonce ever leaks — a transcript, a prompt echoed back in a
// document — removing it is what stops the leak becoming a forged fence.
//
// The tag name goes too, and that half needs no leak to matter: an issue body
// containing `</untrusted-issue-text-0000000000000000>` would otherwise reach
// the model verbatim, and whether a model checks the nonce on a closing tag it
// has already seen is an assumption about an LLM rather than a mechanism. With
// the tag name removed, no second tag-shaped string exists to check.
//
// Both matches are made under ASCII case folding. The nonce is hex, which is
// case-insensitive to every reader that matters — the model included — so an
// attacker who has seen a lowercase nonce gets the uppercase variant for free,
// and a byte-exact comparison hands it to them.
//
// What this cannot reach, and does not claim to: a string that only resembles
// the tag — Unicode confusables (`untrustеd`, Cyrillic е), or whitespace broken
// into the tag name. Those are not the fence and can never be, because they do
// not match the opening tag the model was shown; folding them away would mean
// normalising arbitrary issue text and mangling legitimate non-ASCII bodies.
// The base prompt's guard paragraph is what covers text that merely looks like
// a marker; this function is what guarantees no text that *is* one survives.
//
// One pass per needle suffices: the replacement contains neither the nonce nor
// the tag name, so it separates whatever text surrounded a match rather than
// letting the two sides close up into a fresh copy of it.
func strip(text, nonce string) string {
	return replaceFold(replaceFold(text, fenceTag), nonce)
}

// replaceFold swaps every ASCII-case-insensitive occurrence of needle for
// strippedMarker. needle must already be lowercase.
//
// The fold is done byte by byte rather than by lowercasing the whole string,
// because Unicode lowercasing can change a string's length — U+0130 becomes two
// runes — and an index taken against a folded copy would then point into the
// wrong place in the original.
func replaceFold(text, needle string) string {
	if needle == "" {
		return text
	}

	var out strings.Builder
	rest := text
	for {
		at := indexFold(rest, needle)
		if at < 0 {
			out.WriteString(rest)
			return out.String()
		}
		out.WriteString(rest[:at])
		out.WriteString(strippedMarker)
		rest = rest[at+len(needle):]
	}
}

// countFold counts ASCII-case-insensitive occurrences of needle, non-overlapping.
func countFold(text, needle string) int {
	if needle == "" {
		return 0
	}

	count := 0
	rest := text
	for {
		at := indexFold(rest, needle)
		if at < 0 {
			return count
		}
		count++
		rest = rest[at+len(needle):]
	}
}

// indexFold is strings.Index under ASCII case folding, or -1.
func indexFold(text, needle string) int {
	for i := 0; i+len(needle) <= len(text); i++ {
		if matchesFold(text[i:i+len(needle)], needle) {
			return i
		}
	}
	return -1
}

// matchesFold reports whether two equal-length strings match byte for byte
// once ASCII letters are folded to lowercase.
func matchesFold(a, b string) bool {
	for i := range len(a) {
		if lowerASCII(a[i]) != lowerASCII(b[i]) {
			return false
		}
	}
	return true
}

// lowerASCII folds one byte. Bytes outside A-Z — including every byte of a
// multi-byte rune, which are all >= 0x80 — are returned unchanged.
func lowerASCII(b byte) byte {
	if 'A' <= b && b <= 'Z' {
		return b + ('a' - 'A')
	}
	return b
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
	// Counted under the same fold strip uses, and counted on the tag as well as
	// the nonce. Either alone leaves a hole: a case-flipped nonce satisfies a
	// byte-exact count, and a tag carrying an invented nonce satisfies a
	// nonce-only count. Together they say the prompt holds exactly one fence.
	if got := countFold(rendered, fenceTag); got != 2 {
		return fmt.Errorf("%d untrusted-text tags in the rendered prompt, want 2: some interpolated text was not stripped and carries a tag of its own", got)
	}
	if got := countFold(rendered, nonce); got != 2 {
		return fmt.Errorf("the fence nonce appears %d times in the rendered prompt, want 2: some interpolated text was not stripped and the fence can be forged", got)
	}
	return nil
}
