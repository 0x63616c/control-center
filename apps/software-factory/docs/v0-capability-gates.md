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
`019fba69-606e-73a0-97bb-10a563253354`, completed successfully, and ended with
a `turn.completed` envelope containing numeric `input_tokens`,
`cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens`. Its
JSONL stdout crossed an HTTP boundary one event at a time into a separately
built and separately running append-only sink. The sink fsyncs every accepted
event before returning. It had received events while the target container was
still running, retained all four events after Docker removed the container and
its `/work` filesystem, and still exposed the terminal envelope and usage.
This is the executable shape of the planned trusted Run Worker to per-Run
checkpoint API boundary; it is not the production Store implementation.

A second, fresh target-image process was given that exact ID through
`codex exec resume <id> -`. It failed before producing a resumed turn:

```text
thread/resume failed: no rollout found for thread id 019fba69-606e-73a0-97bb-10a563253354
```

Conclusion: **fresh-filesystem resume is not proved and is currently
unavailable for a completed thread with the target Codex CLI/authentication
mode.** The controlled pre-identity probe starts the actual target `codex exec`
process with an open FIFO withholding prompt bytes and EOF. The container
wrapper records the live child PID and `/proc/<pid>/exe`; Docker process
inspection independently verifies the `codex exec` command before the harness
kills it with exit 137. On this Apple Silicon host, the amd64 executable appears
through Docker Desktop's Rosetta path. The probe found zero rollout files and
no `thread.started` event. A second probe captured thread ID
`019fba69-8afe-7e31-bbac-9c8ae48d3075`, killed that container with exit 137
immediately after `thread.started`, and received the same `no rollout found`
error from a fresh container. The actual pre-identity process, absence of
resumable state, incremental sink delivery, post-deletion sink survival,
terminal envelope, required usage fields, both kill points, and negative
disclosure scan were all verified; the harness fails if any required probe does
not occur.

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

The script builds its narrow event-sink helper, exits non-zero when either
resume is unavailable or any required probe is missing, and prints only the
image, thread IDs, event count, terminal usage summary, verification booleans,
exit codes, and final resume errors. The temporary sink store is independent of
the worker filesystem and is deleted only when the overall harness exits.

## Temporal Session harness

`internal/runworkercapability/session_integration_test.go` uses the Go SDK's
real Temporal CLI dev server (`testsuite.StartDevServer`), not the unit
`TestWorkflowEnvironment`. It pins the dev-server download to CLI `v1.8.1`.
The harness starts one main worker and two separately registered private
workers as distinct helper subprocesses. Each helper receives only a marker
name and resolves it under its own configured temporary root. The first worker
writes and reads `repository-state-v1` across two Session activities; both
results report its identity and OS process ID. A direct activity on the second
worker reports its different identity/process and that the same marker name is
absent from its root. A main-control activity still runs on the main worker. A
second scenario stops and replaces the main worker between the two Session
activities; both retain the original private-worker process, root marker, and
identity, while the main-control activity runs on the replacement main worker.

Run it with:

```sh
cd apps/software-factory
go test -race -tags=integration ./internal/runworkercapability
```

This proves affinity and main-worker restart behavior only. It intentionally
also stops the active private-worker subprocess, verifies that the Session
reports failure while main-control work remains callable, then creates a
replacement Session on a new helper process and second root. Its first activity
proves the original marker is absent from that root; its next activity writes
and reads `replacement-state-v1` while reporting the replacement identity and
process ID.
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

## Target dispatcher replay fixture

`internal/workflows/testdata/target-dispatcher-admission.json` is an export
from a Temporal CLI dev-server execution of the dormant v0 `Dispatcher`. It
retries one no-work `AwaitDispatchableTickets` attempt, then completes the
next wait and starts one `WorkOnTicket` child, preserving the
wait-to-admission command sequence before the PR 8 registration cutover makes
the workflow live.
`TestTargetDispatcherHistoryReplays` registers the target dispatcher exactly
as the eventual worker does and replays that checked-in JSON export.

Regenerate it only through the manual dev-server test when intentionally
refreshing this compatibility evidence:

```sh
cd apps/software-factory
go test -tags=manual -run '^TestExportTargetDispatcherHistory$' \
  ./internal/runworkercapability
```
