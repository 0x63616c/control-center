package work

// Transcript is one stage attempt's whole raw event stream, as JSONL.
//
// It exists for #434's step 3 (D5): once RunStage executes inside a sandbox
// pod's own process, the transcript it writes lands on that pod's local disk,
// never on the durable NFS-backed volume the rest of this service trusts —
// the pod is disposable and DeleteSandbox destroys everything under it. This
// type is how the bytes travel back out: RunStage reads its own local
// transcripts.Sink and carries the whole thing home as a field on
// RunStageOutput, for a new activity (PersistTranscript, on the MAIN task
// queue) to replay into the real transcripts.Sink — the same sink and the
// same on-disk path every transcript has always used, untouched.
//
// A named byte slice rather than an opaque wrapper like CredentialFile: a
// transcript is not a secret, so there is nothing here to redact or refuse to
// serialise. The type exists only to say, at every signature that carries
// one, what these bytes are and roughly how big they get to be — not to gate
// access to them.
//
// Size is a real, deliberate cost here, not an oversight: the largest
// transcript measured on disk was 292 KiB, which lands around 57% of
// Temporal's 512 KiB payload warn threshold. That is accepted — it is the
// price of relaying at all — but it is also why nothing else is added to
// RunStageOutput's payload alongside it, and why PersistTranscript carries
// exactly one Transcript per call rather than batching several.
type Transcript []byte

// Bytes returns the transcript's raw content.
func (t Transcript) Bytes() []byte { return []byte(t) }
