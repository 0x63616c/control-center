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
`plan → review → revise → implement → propose`, each stage a `codex exec` inside a
disposable per-ticket Kubernetes pod. It opens a PR and stops. Merging stays human.

Design and rationale: [ADR-0011](../../docs/adr/0011-software-factory-autonomous-ticket-work.md).

## Layout

One Go module rooted here, not one per component, because more components are expected and
splitting a module later is cheap while unsplitting is not. A second Go binary becomes
another `cmd/<name>/` sharing `internal/`.

```
cmd/worker/        composition root: manual DI, graceful shutdown
internal/
  work/            domain vocabulary — every seam is expressed in these types
  config/          the only place os.Getenv is legal
  clock/           the only place time.Now is legal
  telemetry/       logging + Prometheus, injected
  workflows/       deterministic only — see the section below
  activities/      all side effects; declares the interfaces it consumes
  clients/         github, k8s, codex, codexauth — each seals its SDK
  prompts/         stage prompts + JSON schemas, go:embed
images/
  worker/          the worker image
  sandbox/         the per-ticket sandbox image and its entrypoint
```

This nests where the rest of `apps/*` is flat. That is deliberate: `software-factory` is one
product with several components, and nothing in the repo globs `apps/*` — every CI path
filter, Dockerfile path and bun workspace is enumerated by name, so the nesting costs
nothing. Both images build off the single path filter `apps/software-factory/**`; a
worker-only edit therefore rebuilds the sandbox too, which is the cheap direction to be
wrong in.

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

## Operating protocol

- TDD test-first for workflows and activities. The dispatcher's concurrency cap, pause and
  reconcile logic are unit tests, not things you find out about in production.
- Done = `golangci-lint` clean and relevant tests pass, verified by running them, not asserted.
- Never silence a linter. Fix the code.
- Stop and ask before anything irreversible or outward-facing.
