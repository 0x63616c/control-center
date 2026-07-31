# AGENTS.md — software-factory

> **Scope: this directory tree only.**
> Everything in this file and in `docs/` under it governs `apps/software-factory/` —
> the Go module **and** the sandbox image under `images/` — and nothing else. That the
> sandbox is in scope is deliberate: the argv-only guarantee below spans both, and a
> standard that stopped at the Go code would disclaim one of its own enforcement sites.
> The rest of world-wide-webb — every TypeScript app, `features/`, `packages/`, `infra/` —
> is **unaffected** and keeps following the root `AGENTS.md`. Do not cite these standards
> in a review of code outside this tree. If we ever want them repo-wide, that is a
> separate, deliberate decision.

The root `AGENTS.md` still applies here (worktrees, secrets, commit and PR discipline,
issue tracking). This file **adds** to it; it does not replace it.

## What this is

A Go Temporal worker that autonomously works GitHub issues labelled `auto`: a dispatcher
workflow polls for eligible tickets and a WorkTicket workflow per issue runs
`plan → implement → review`, looping implement/review under turn budgets, each stage a
`codex exec` inside a disposable per-ticket Kubernetes pod. The workflow itself opens or
updates the pull request after every push implement makes. Merging stays human.

On an `OutcomeFailed` run, the terminal flow clears `auto` and adds `failed` to
the issue plus any run-owned PR before posting its existing outcome status.

What actually happens end to end — what each stage reads, may write and is trusted for, where
a human is required, and what is absent: [`docs/system-map.md`](./docs/system-map.md).
Design and rationale: [ADR-0011](../../docs/adr/0011-software-factory-autonomous-ticket-work.md).
Running it for the first time, and stopping it:
[first-run runbook](../../docs/runbooks/software-factory-first-run.md).

## Layout

One Go module rooted here, not one per component, because more components are expected and
splitting a module later is cheap while unsplitting is not. A second Go binary becomes
another `cmd/<name>/` sharing `internal/`.

```
cmd/worker/        composition root: manual DI, graceful shutdown
internal/
  work/            domain vocabulary — every seam is expressed in these types
  store/           Postgres record door with private sqlc output and in-memory fakes
  config/          the only place os.Getenv is legal
  clock/           the only place time.Now is legal
  telemetry/       logging + Prometheus, injected
  workflows/       deterministic only — see the section below
  activities/      all side effects; declares the interfaces it consumes
  clients/         github, k8s, codex, codexauth — each seals its SDK
  status/          the comments a run posts on its ticket, as golden files
  transcripts/     stage event streams on the worker's volume, as JSONL
  prompts/         stage prompts + JSON schemas, go:embed
images/
  worker/          the worker image
  sandbox/         the per-ticket sandbox image and its entrypoint
  relay/           the stateless GitHub webhook fan-out edge service
```

This nests where the rest of `apps/*` is flat. That is deliberate: `software-factory` is one
product with several components, and nothing in the repo globs `apps/*` — every CI path
filter, Dockerfile path and bun workspace is enumerated by name, so the nesting costs
nothing. All three images build off the single path filter
`apps/software-factory/**`; a change therefore rebuilds the worker, sandbox, and
relay together, which prevents a shared module edit from shipping a stale image.

## Where the standards came from

Adapted from the `software-factory` repo's SoftwareStyle, which was written for a Go
codebase maintained by agents. What we took, translated and deliberately skipped is
recorded in [`docs/style-adoption.md`](./docs/style-adoption.md) — read it before arguing
that a rule from that repo applies here, because several do not.

- Values and tenets: [`docs/SoftwareStyle.md`](./docs/SoftwareStyle.md)
- The wall: [`.golangci.yml`](./.golangci.yml)

## Priority ordering (resolves every trade-off, high beats low)

**Legibility > Correctness > Operability > Economy.** Machine performance is unranked —
this is LLM-latency-bound; below ~1s, don't care. Testability is a floor beneath all four
and is never traded.

## The floor

No unit test touches the real world. Every external edge — codex, the k8s API, GitHub, the
clock, the filesystem — sits behind a narrow injectable interface so a test hands it a
fake. Temporal's `testsuite` covers workflow replay without a real server.

## The one thing this codebase gets wrong most easily

**Workflow code is not normal Go.** Inside `internal/workflows/**` you must use
`workflow.Now`, `workflow.Sleep`, `workflow.Go` and `workflow.SideEffect` — never
`time.Now`, `time.Sleep`, `go` or `rand`. Replay determinism depends on it, and a
violation surfaces later as a corrupted run, not a compile error. The linter enforces what
it can; the rest is on you.

`workflow.Context` is **not** `context.Context`. Activities and clients get the real one.

## Changing an existing workflow

**Treat a workflow command-sequence change as a history compatibility change.** Temporal
replays a workflow's complete history through the deployed code for every workflow task and
expects the commands it issues to line up with that history. If they diverge, Temporal refuses
to guess and reports a non-determinism error; the open execution can then wedge retrying
workflow tasks.

This applies to any edit that can change the ordered workflow commands: activity calls, child
workflow starts, timers, selectors that choose when to schedule a command, and their
command-producing branches. It does **not** by itself apply to an activity implementation body
or to a helper the workflow never calls. Normal `testsuite` tests prove intended new behavior;
they do not prove that a persisted old history still replays.

`Dispatcher` is the primary risk here. It is the singleton
`software-factory-dispatcher`, remains open for hours, and carries its state over
`ContinueAsNew`, so a normal deploy commonly reaches an open run. `WorkTicket` normally
finishes sooner and is less exposed, but an open ticket workflow can still replay and is not
exempt.

When changing a command sequence, put the old and new decision branches behind
`workflow.GetVersion` **at the changed command branch**. Give the change a stable, unique ID
for that compatibility transition; do not add an unrelated marker elsewhere. Histories from
before the change must keep replaying the legacy branch, while new histories take the new
branch. Keep the legacy branch until no retained history can need it. For example:

```go
version := workflow.GetVersion(ctx, "dispatcher-claim-v2", workflow.DefaultVersion, 1)
if version == workflow.DefaultVersion {
	// Preserve the command sequence recorded by pre-change histories.
	return claimLegacy(ctx, ticket)
}
return claimV2(ctx, ticket)
```

When unsure whether an edit is compatible, replay an exported real or production-like history
against the changed workflow before deploying. Export the exact execution (include `--run-id`
when replaying a non-current run) from the same admin-tools context used by the runbook:

```sh
kubectl -n temporal run tmp-temporal-cli --rm -i --restart=Never \
  --image=temporalio/admin-tools:1.31.2 --command -- sh -c \
  'sleep 2; temporal --address temporal-server:7233 --namespace software-factory \
  workflow show --workflow-id <workflow-id> --run-id <run-id> --output json' \
  > <workflow-id>-<run-id>.json
```

Use `worker.WorkflowReplayer` in a focused Go test, registering the workflow exactly as the
worker does. `ReplayWorkflowHistoryFromJSONFile` consumes the JSON produced by `workflow show`:

```go
func TestReplayDispatcherHistory(t *testing.T) {
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflow(workflows.Dispatcher)

	require.NoError(t, replayer.ReplayWorkflowHistoryFromJSONFile(
		nil, "testdata/dispatcher-history.json"))
}
```

### Recovery for an already wedged dispatcher

This is the recovery for the known dispatcher non-determinism failure, not a substitute for
versioning or a replay check. PR #478 changed the dispatcher's `claim()` command path and is
the concrete incident that prompted this rule. Terminate the wedged execution, restart the
worker so startup ensures a fresh dispatcher, then unpause that fresh dispatcher: it currently
starts paused by configuration.

```sh
kubectl -n temporal run tmp-temporal-cli --rm -i --restart=Never \
  --image=temporalio/admin-tools:1.31.2 --command -- \
  temporal --address temporal-server:7233 --namespace software-factory \
  workflow terminate --workflow-id software-factory-dispatcher

kubectl -n software-factory rollout restart deploy/software-factory-worker

kubectl -n software-factory rollout status deploy/software-factory-worker --timeout=5m

kubectl -n temporal run tmp-temporal-cli --rm -i --restart=Never \
  --image=temporalio/admin-tools:1.31.2 --command -- \
  temporal --address temporal-server:7233 --namespace software-factory \
  workflow signal --workflow-id software-factory-dispatcher \
  --name update-config --input '{"paused":false}'
```

Confirm the replacement execution is running with `workflow describe --workflow-id
software-factory-dispatcher` in the same CLI context. The separate workflow-task retry and
alerting problem is out of scope here.

## Operating protocol

- TDD test-first for workflows and activities. The dispatcher's concurrency cap, pause and
  reconcile logic are unit tests, not things you find out about in production.
- Done = `golangci-lint` clean and relevant tests pass, verified by running them, not asserted.
- Never silence a linter. Fix the code.
- Stop and ask before anything irreversible or outward-facing.
