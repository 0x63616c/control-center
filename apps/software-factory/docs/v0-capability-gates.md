# v0 capability gates

This is the evidence record for PR 0.5. It describes observations, not target
runtime behavior. The legacy worker registrations remain unchanged.

## Codex fresh-filesystem resume

The target sandbox image pins `codex-cli 0.145.0`. On 2026-07-31, the exact
image (`sf-sandbox:local`, built from `images/sandbox/Dockerfile`) was run twice
with its normal authentication layout: an auth document mounted at
`/var/run/secrets/software-factory/codex-auth.json`, symlinked into a fresh
`CODEX_HOME` at `/work/.codex/auth.json`. The harness never emits the auth
document. Its negative disclosure check compares long auth string values
against every captured stdout/stderr file inside a mode-restricted temporary
directory, prints no matches or values, and deletes the directory on exit.

The first process emitted `thread.started` with thread ID
`019fba53-ad6b-7630-a7ac-9b0f774ed9be`, completed successfully, and ended with
a `turn.completed` envelope containing numeric `input_tokens`,
`cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens`. Its
JSONL stdout is transcript material that a caller can stream while the process
runs; it is independent of the discarded `/work` filesystem.

A second, fresh target-image process was given that exact ID through
`codex exec resume <id> -`. It failed before producing a resumed turn:

```text
thread/resume failed: no rollout found for thread id 019fba53-ad6b-7630-a7ac-9b0f774ed9be
```

Conclusion: **fresh-filesystem resume is not proved and is currently
unavailable for a completed thread with the target Codex CLI/authentication
mode.** A controlled pre-identity probe killed its container with exit 137
while the target entrypoint was held before starting Codex and verified that no
`thread.started` event existed. A second probe captured thread ID
`019fba53-ca62-77b0-b053-40837e65f5c4`, killed that container with exit 137
immediately after `thread.started`, and received the same `no rollout found`
error from a fresh container. The terminal envelope, required usage fields,
both kill points, and negative disclosure scan were all verified; the harness
fails if any one of those required probes does not occur.

The safe v0 boundary is therefore explicit: A02 thread continuation is only
within a surviving Run Worker generation. Permanent worker loss follows A12 and
I08: the incomplete Attempt ends failed, its durable transcript/usage evidence
is retained where captured, and the workflow may authorize a fresh Attempt
within its existing Run-wide budget. Do not persist Codex rollout directories,
and do not claim cross-filesystem provider resume.

Run the reproducible gate without exposing the credential value:

```sh
apps/software-factory/scripts/verify-v0-codex-resume.sh \
  sf-sandbox:local /path/to/auth.json
```

The script exits non-zero when either resume is unavailable or any required
probe is missing. It prints only the image, thread IDs, terminal usage summary,
verification booleans, exit codes, and final resume errors. It does not persist
the raw transcript.

## Temporal Session harness

`internal/runworkercapability/session_integration_test.go` uses the Go SDK's
real Temporal CLI dev server (`testsuite.StartDevServer`), not the unit
`TestWorkflowEnvironment`. It pins the dev-server download to CLI `v1.8.1`.
The harness starts one main worker and two separately registered private
workers, then proves a Session's two repository-affine activities both run on
the selected private worker. The first activity writes a real filesystem
marker and the second reads the same value from that file. A main-control
activity still runs on the main worker. A second scenario stops and replaces
the main worker between the two Session activities; both retain the original
private-worker identity and filesystem marker, while the main-control activity
runs on the replacement main worker.

Run it with:

```sh
cd apps/software-factory
go test -race -tags=integration ./internal/runworkercapability
```

This proves affinity and main-worker restart behavior only. It intentionally
also stops the active private worker, verifies that the Session reports failure
while main-control work remains callable, then creates a replacement Session
whose activity reports the separately registered replacement worker identity.
It proves Temporal's filesystem/routing capabilities and failure boundary. It
does not prove domain Agent Attempt closure, Git restoration, budget
preservation, `WorkOnTicket` recovery, or resumed Codex execution; those remain
PR 4/5 behavior.

## Legacy replay fixture

`internal/workflows/testdata/factory-dispatcher-paused.json` is an export from
a real Temporal CLI dev-server execution of the unchanged legacy
`FactoryDispatcher` registration. It uses valid legacy policy/config input,
completes the legacy orphan-sweep activity, starts and fires the dispatcher's
poll timer, completes the subsequent workflow task, starts the next timer, and
is then terminated so its history remains finite.
`TestLegacyFactoryDispatcherHistoryReplays` registers only the unchanged
legacy workflow with `worker.NewWorkflowReplayer` and replays that checked-in
JSON export.

Ordinary test runs only parse and replay the checked-in fixture; they start no
server and use no real clock. Regenerate it only through the explicit `manual`
build tag when intentionally refreshing the legacy evidence:

```sh
cd apps/software-factory
go test -tags=manual -run '^TestExportLegacyFactoryDispatcherHistory$' \
  ./internal/runworkercapability
```
