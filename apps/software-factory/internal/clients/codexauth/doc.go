// Package codexauth owns the model provider's OAuth credential: it is the only
// thing in this service that holds a refresh token, and the only thing that
// refreshes one.
//
// That exclusivity is the design. The refresh token is single-use and
// rotating, and the CLI holds no cross-process lock around its credential file,
// so two processes sharing one credential eventually invalidate each other. A
// sandbox is therefore handed a credential file whose refresh token is blank —
// but NOT one carrying only an access token, which will not load at all. See
// "What the CLI needs in the file it is handed" below before composing one.
//
// # The invariants
//
// INV-1. At most one actor in the world presents a given refresh token per
// credential generation, and the pair it receives is durably stored before any
// other actor may read the credential. The one exception is the bounded
// takeover below, which is argued for rather than assumed.
//
// INV-2. No actor presents a refresh token whose previous presentation has an
// unknown outcome.
//
// Violating either does not degrade service, it bricks it: recovery is a human
// running a browser login. That asymmetry — cheap to be conservative,
// unrecoverable to be wrong — decides every policy here. Where a choice exists
// between halting loudly and continuing plausibly, this package halts.
//
// # The mechanism
//
// The credential Secret's resourceVersion compare-and-swap is used as a LEASE,
// acquired BEFORE the refresh token is presented:
//
//	Get   → auth.json, refresh_state.json, version V0
//	CAS   → Put({refresh_state.json: attempt{holder: me}}, V0) → V1     the lease
//	        …only if that succeeded…
//	OAuth → present the refresh token
//	CAS   → Put({auth.json: rotated, refresh_state.json: {serial+1}}, V1)
//
// The apiserver applies a preconditioned update linearizably, so of N actors
// holding V0 exactly one write succeeds. Because presenting is gated behind
// that write, at most one actor per generation reaches the provider — across
// processes, across nodes, including a kubectl debug pod, a one-off Job, and a
// terminating pod during a Recreate rollout. Ordering is the whole of it: the
// same CAS performed after the OAuth call would be an audit log of a race that
// already happened.
//
// replicas: 1 buys nothing this relies on. It lowers the frequency of
// contention and that is all.
//
// A conflict BEFORE the destructive act is contention: nothing was presented,
// so re-read and start over, almost always finding a token somebody else just
// rotated. A conflict AFTER it is news, and never licenses presenting again.
//
// # Two actors, walked through
//
// Both read V0 and both want to refresh. A's lease write moves the object to
// V1; B's fails with a conflict, having presented nothing. B waits a poll
// interval, re-reads, and finds either A's rotated credential (which it
// returns, with no network call) or A's live lease (which it waits out). If A
// finishes, B returns A's token. If A holds the lease past B's wait, B returns
// ErrRefreshInProgress, which is retryable precisely because B spent nothing.
//
// If A dies between the OAuth 200 and its settle write — a SIGKILL during a
// deploy, which is ordinary rather than exotic — its rotated pair is lost by
// construction, and its attempt marker survives. B finds an expired,
// unresolved attempt and takes it over ONCE, recording takeover_of: A. Either
// the provider never consumed A's grant, in which case B recovers fully, or it
// did, in which case B is refused and the operator learns the cause by name —
// the dead holder and when it started — rather than a bare refusal code from
// the provider. A second unresolved takeover halts, so no crash-loop can
// present repeatedly.
//
// Why one takeover is safe: A is dead or definitively failed (its lease TTL is
// ten times the hard bound on one presentation); if A got a pair and died, that
// pair is already lost whatever we do; and if A were somehow alive and about to
// settle, its settle is preconditioned on the version B just moved, so it
// conflicts and halts rather than writing.
//
// The takeover comparison is a wall-clock one across processes: A writes
// lease_expires_at from its clock and B evaluates it against B's. That is sound
// here because prod is a single node, so every pod that can hold this lease
// shares one kernel clock. On a multi-node cluster it would need lease renewal
// or coordination.k8s.io/Lease's own semantics, and this comment is the notice
// that the assumption exists.
//
// The lease lives in the credential Secret rather than in a Lease object
// deliberately. Two objects would be two linearization points, and a lease held
// while the credential moved would be representable.
//
// # Operator signals and recovery
//
// Every fatal condition here needs the same thing: a human running `codex
// login` locally and re-seeding the Secret out of band. Seeding is manual by
// design — the refresh token rotates on first use, so a value in git or in a
// Pulumi stack is a corpse within a day, and Pulumi must not own this Secret.
//
//	metric                                     meaning                    recovery
//	codex_auth_credential_dead{unseeded}       never seeded, or deleted   seed it
//	codex_auth_credential_dead{rejected}       revoked or already spent   re-seed
//	codex_auth_credential_dead{outcome_unknown} a result was lost         see below
//	codex_auth_credential_dead{single_writer_violated} a foreign writer   find who first
//	codex_auth_credential_dead{credential_lost} rotated, not stored       re-seed
//	codex_auth_refresh_total{takeover} non-zero a holder died mid-refresh nothing; it recovered
//
// For outcome_unknown the operator has a choice, and it is a real one: re-seed,
// or authorise one more presentation of a possibly-spent token by clearing the
// lease state. The latter is:
//
//	kubectl -n <ns> patch secret <name> --type=json \
//	  -p='[{"op":"replace","path":"/data/refresh_state.json","value":""}]'
//
// A blank value is read here as "no attempt in flight"; the key is never
// removed, because the store can blank a key but not delete one. A re-seed must
// replace the Secret's data wholesale rather than merging auth.json, since a
// stale refresh_state.json left behind would halt a perfectly healthy
// credential on its next refresh. The serial may move backwards if a Secret is
// restored from a backup; that is benign, because every comparison here is an
// equality and none is an ordering.
//
// # What the CLI needs in the file it is handed
//
// Read from codex-cli rust-v0.145.0, and load-bearing for whoever composes a
// sandbox's credential file — which is not this package, since
// activities.TokenSource yields an access token and nothing else.
//
//   - tokens.id_token is MANDATORY and must be a syntactically valid JWT. It
//     has no serde default and a deserializer that parses it, and the CLI reads
//     the whole file in one pass, so a missing or malformed id_token fails the
//     ENTIRE parse rather than that one field.
//   - tokens.account_id is what becomes the ChatGPT-Account-ID header. It is
//     read straight from this field for ChatGPT logins and is NOT derived from
//     the id_token's claims on that path, and a refresh never repopulates it.
//     Absent, the header is silently omitted and the request goes unscoped —
//     so it must be preserved verbatim, which is what the lossless patch here
//     does.
//   - The OPENAI_API_KEY key must be PRESENT, though it may be null: it has no
//     serde default either. A non-null value selects API-key mode and the
//     ChatGPT tokens are ignored entirely.
//   - auth_mode wins over that inference when present; "chatgpt" is the value
//     for a subscription login.
//
// All four are keys this service does not model, and all four survive a
// rotation because the file is patched rather than re-marshalled.
//
// # Leak audit
//
// Done here rather than assumed, because the repository's rule is that no
// secret value is ever printed, logged or stored outside its destination.
//
//   - Refreshed and the parsed credential file are Credentials behind
//     redacting String and LogValue, and their raw bytes are never formatted.
//   - refresh_state.json carries holder, timestamps, serial and outcome, and
//     nothing copied from a token.
//   - The Kubernetes client logs key names, namespace, name and
//     resourceVersion. Never a value, and never a length: a length is a
//     fingerprint.
//   - Every wrapped error names a Secret, a key or a step. No token value is
//     interpolated into one, including the OAuth error path.
//   - The refresh token travels in a JSON request body, never in a URL or a
//     query string; only the provider's own error code is logged from a
//     response, never the body that carries the new pair.
//   - AccessToken returns a work.Credential, whose MarshalJSON refuses, so an
//     activity that tried to return one to a workflow fails loudly rather than
//     writing it to Temporal history.
//   - Test fixtures are synthetic unsigned JWTs. No credential-shaped value
//     exists in this repository.
package codexauth
