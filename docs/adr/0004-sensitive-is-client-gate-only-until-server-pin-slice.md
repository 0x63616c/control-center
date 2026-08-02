# `sensitive` is a client gate only; server-side PIN is deferred to a final separate slice

The App `sensitive` flag drives the shell's `<PinGate>` (client-side Unlock / PIN Session) **only**.
The generated web runtime normalizes that manifest flag through `accessFor(tileId)` as
`requiresSessionUnlock`; `private` becomes the distinct `requiresFreshUnlock` policy. Tile View
entries carry no access flags, so the App manifest is the single declaration seam.
Until a dedicated, last-sequenced slice ("Slice S") ships server enforcement, `manifest.sensitive`
means *client gate, parity with today* — a direct tRPC call to a sensitive App's procedures still
returns the data. This is enforced as a rule: **no slice may ship a `sensitive` flag that looks
server-enforced while a direct call still returns the data.** The manifest doc comment and this ADR
say so explicitly.

Server enforcement (`session.unlock(pin)` — the first server-side PIN compare — a `requireUnlock`
middleware, and `procedureFor(manifest)` gating each sensitive App's procedures, plus a codegen
guard requiring every sensitive App to build from the gated base) is a **separate change, sequenced
last, not bundled into any tile migration.**

## Why (the trade-off)

Bundling server-PIN into each tile migration would block all ~18 App migrations on a security change
that touches tRPC context, middleware, and the client token flow. Deferring it lets the structural
refactor proceed one small green push at a time. The cost: for the entire migration window,
`sensitive` provides no server boundary despite its name — accepted on purpose so the refactor
never ships **false security confidence** by pretending a structural flag is a security control.

## Why it is recorded

Surprising without context — a reader (or security reviewer) sees a flag named `sensitive` on an App
and reasonably assumes the server enforces it; discovering a direct tRPC call returns the data
anyway is a dangerous surprise, a constraint not visible in the code. A real trade-off — migrate now
with a documented client-only gate vs. block the whole refactor on server-PIN. Hard to reverse in
the sense that matters here: every sensitive App is deployed to prod under client-only semantics for
the full migration, and that window cannot be retroactively made secure — the sequencing commitment
(server-PIN strictly last, strictly separate) is deliberate and load-bearing for keeping the refactor
honest. (Today's PIN is already client-only per `CONTEXT.md`; this ADR records the decision to
*keep* it that way through the migration and to make server enforcement its own explicit slice.)
