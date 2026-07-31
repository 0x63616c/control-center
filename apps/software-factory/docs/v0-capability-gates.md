# v0 capability gates

This is the evidence record for PR 0.5. It describes observations, not target
runtime behavior. The legacy worker registrations remain unchanged.

## Codex fresh-filesystem resume

The target sandbox image pins `codex-cli 0.145.0`. On 2026-07-31, the exact
image (`sf-sandbox:local`, built from `images/sandbox/Dockerfile`) was run twice
with its normal authentication layout: an auth document mounted at
`/var/run/secrets/software-factory/codex-auth.json`, symlinked into a fresh
`CODEX_HOME` at `/work/.codex/auth.json`. The auth document was mounted but
never read or printed by the harness.

The first process emitted `thread.started` with thread ID
`019fba39-129a-7c81-a1d5-415be1e4236d`, completed successfully, and emitted
terminal usage fields (`input_tokens`, `cached_input_tokens`, `output_tokens`,
and `reasoning_output_tokens`). Its JSONL stdout is transcript material that a
caller can stream while the process runs; it is independent of the discarded
`/work` filesystem.

A second, fresh target-image process was given that exact ID through
`codex exec resume <id> -`. It failed before producing a resumed turn:

```text
thread/resume failed: no rollout found for thread id 019fba39-129a-7c81-a1d5-415be1e4236d
```

Conclusion: **fresh-filesystem resume is not proved and is currently
unavailable for a completed thread with the target Codex CLI/authentication
mode.** This already fails the prerequisite more strongly than a kill-point
experiment could: a normally completed provider thread cannot be resumed after
the worker filesystem is discarded. No controlled-kill variants were run,
because they cannot turn that failed prerequisite into evidence of recovery.

Run the reproducible gate without exposing the credential value:

```sh
apps/software-factory/scripts/verify-v0-codex-resume.sh \
  sf-sandbox:local /path/to/auth.json
```

The script exits non-zero when resume is unavailable and prints only the image,
thread ID, terminal usage summary, exit codes, and final resume error. It does
not persist the raw transcript.

## Temporal Session harness

`internal/runworkercapability/session_integration_test.go` uses the Go SDK's
real Temporal CLI dev server (`testsuite.StartDevServer`), not the unit
`TestWorkflowEnvironment`. It pins the dev-server download to CLI `v1.8.1`.
The harness starts one main worker and two separately registered private
workers, then proves a Session's two repository-affine activities both run on
the selected private worker while a main-control activity runs on the main
worker. A second scenario stops and replaces the main worker between the two
Session activities; both still run on the original private worker and the
main-control activity runs on the replacement.

Run it with:

```sh
cd apps/software-factory
go test -race -tags=integration ./internal/runworkercapability
```

This proves affinity and main-worker restart behavior only. It intentionally
does not claim replacement-worker recovery after permanent Session loss; that
requires the Run Worker/checkpoint implementation blocked on the Codex gate.
