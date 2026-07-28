# Software factory: autonomous ticket work in sandboxed pods

Tickets labelled `auto` are picked up, planned, reviewed, implemented and turned into open
PRs by a self-hosted service — no human in the loop until the PR exists. It runs as a Go
Temporal worker in a new `software-factory` k8s namespace on its own `software-factory`
Temporal namespace and task queue, and executes each ticket's agent stages via `codex exec`
inside a disposable per-ticket pod. Merging the resulting PR — and therefore deploying —
stays a human act.

This replaces `.claude/workflows/grind-tickets.js`, which is deleted. That workflow needed
a human to launch it with an explicit ticket list, ran agents in the operator's own session
against the operator's own checkout, and serialised PR-opening behind a barrier that made
one slow ticket delay every other ticket's PR.

## Why not the existing Temporal worker

`apps/temporal-worker` is deliberately single-namespace, single-task-queue (ADR-0008), and
its workflow set is glob-collected from `features/<id>/temporal.ts` facets. Working tickets
is not app work: no feature, no tile, no place in the `control-center` namespace, and its
activities need the Kubernetes API rather than the product database. It gets its own
worker, namespace and hand-registered workflows. `infra/src/temporal.ts` is the precedent —
a standalone worker owning its own namespace, written as plain k8s objects rather than the
`Workload` component.

Go, not TypeScript. Everything this service touches — Temporal, `client-go`, the Kubernetes
API — is Go-native, and it shares no code with the monorepo. The cost is a second toolchain
in CI.

## A dispatcher workflow, not a schedule

A single long-running **dispatcher** workflow owns the control plane. It timer-loops every
30s, holds the in-flight ticket set in workflow state, and `ContinueAsNew`s to bound
history. Concurrency is `len(inFlight) < cap` against that state — durable, strongly
consistent, and needing no coordination primitive.

Notably **not** the visibility store. Visibility is a search index and eventually
consistent; using it as a semaphore would be a race dressed as a query. The dispatcher
learns a child finished because **children signal it on completion**, and a periodic
reconcile catches children that died without signalling using `DescribeWorkflowExecution` —
a direct lookup by workflow ID, strongly consistent, not a search.

Children are started with `ParentClosePolicy: ABANDON`. This is required, not
stylistic: the default is `TERMINATE`, and `ContinueAsNew` closes the parent run, so the
default would have the dispatcher kill every ticket it had just started, every cycle.

The control surface is deliberately minimal — **one signal and one query**, each taking and
returning exactly one struct so fields can be added compatibly:

- `UpdateConfig` — nil-means-leave-alone, so the same signal serves a deploy pushing new
  config and a human pausing the system by hand.
- `GetStatus` — in-flight tickets, paused state, breaker state.

`Pause`/`Resume` collapse into a config field; a `WorkNow` signal buys at most 30s and was
dropped.

## Claim semantics come from Temporal

Each ticket's workflow ID is `work-ticket-<n>`. Temporal refuses to start a second
workflow with an open run under the same ID, so starting one unconditionally *is* the
claim — no lease table, no advisory lock.

The one piece of reconciliation this genuinely needs: a workflow that dies without running
its cleanup can leave a ticket in a state the dispatcher's query no longer returns. The
dispatcher therefore re-checks tickets it believes are in flight against their actual
workflow state, and releases the ones that aren't.

## One label

`auto` — unchanged, and the only label this system touches. It means *this ticket wants
machine work and none has been delivered*. The machine **removes** it when a PR opens or
when it is blocked, and comments why. A human re-adds it to request another pass.

An earlier draft proposed `auto/todo`, `auto/claimed` and `auto/blocked`. Rejected:
`auto/claimed` existed only to prevent double-work, which workflow-ID uniqueness already
prevents, and the rest reintroduced exactly the stale status-label scheme AGENTS.md
deliberately excludes. Machine state belongs in Temporal, which can be queried; the issue
carries a status **comment** instead, which is chronological and more informative than a
label.

That comment is posted once per run and **edited in place** as the run progresses: picked
up (with a link to the Temporal run), stage transitions, then outcome and token totals. One
live status block per run rather than five comments of spam.

## Sandboxes are plain Pods

One pod per ticket, `restartPolicy: Never`, `activeDeadlineSeconds` as a hard ceiling above
the workflow's own timeout, CPU and memory limits, `automountServiceAccountToken: false`,
and a `sleep infinity` entrypoint — it is a session that stages exec into, not a batch job.
Stage execution is the standard `pods/exec` subresource, which streams and returns a real
exit code.

`kubernetes-sigs/agent-sandbox` was evaluated and rejected for now. Its `Sandbox` CRD is a
lifecycle wrapper around a Pod — stable identity, `volumeClaimTemplates`,
`operatingMode: Suspended`, `shutdownTime` — and is explicitly *not* an isolation boundary;
isolation is delegated to a `RuntimeClass`. Everything it would give us here is already a
Pod field (`activeDeadlineSeconds`) or unnecessary, and its warm pools, suspend/resume and
Go SDK all go unused. Against that: v0.5.x, a live `v1alpha1`→`v1beta1` conversion-webhook
migration, breaking changes across recent point releases, and ~817 KB of CRDs on the
cluster that runs the house. Adopt it the day warm pools or gVisor are wanted — the
workflow code is unchanged either way, only the activity that creates the thing differs.

**No network isolation in v1, deliberately and with a correction.** An earlier draft
specified a NetworkPolicy egress allowlist. That would have been a no-op file: this cluster
runs Flannel, which implements no policy engine, and has zero NetworkPolicies. Achieving
isolation needs either a policy engine (Calico alongside Flannel, or Cilium — a
cluster-wide change to the box running the house) or per-pod iptables written by an init
container holding `NET_ADMIN` while the main container runs without it. The latter is the
cheap path when we want it, and it blocks RFC1918 rather than allowlisting hostnames, which
plain iptables cannot do.

**gVisor deferred.** Talos bakes system extensions into the boot image, so adding `runsc`
changes the schematic ID and requires `talosctl upgrade` — a reboot of the single
control-plane node. What it buys is protection against container escape via kernel exploit.
The realistic threat is the arbitrary npm postinstall scripts `bun install` executes every
ticket, and those get code execution inside the container either way; gVisor only blocks
escalation to the host. Meanwhile the sandbox holds strictly less than the laptop that runs
`bun install` on this repo daily. Revisit if anyone but the owner can file an `auto`
ticket — untrusted execution plus prompt injection is a different threat model.

## Stages, and why each is a separate `codex exec`

`plan → review → revise → implement → propose`, each its own Temporal activity with its own
timeout and retry policy, and each its own `codex exec` invocation. A fresh invocation is a
fresh thread, which is the point: the adversarial reviewer must not share context with the
planner, and process boundaries enforce that better than prompt instructions do.

Handoff is structured — `--output-schema` constrains the final message to a JSON Schema and
`-o` writes it to a file the worker reads out of the pod — so a plan travels as data, not
as conversation. Success and failure come from the process exit code and the `turn.failed`
/ top-level `error` events in `--json`; both are load-bearing in the CLI's own source and
neither requires parsing human-readable text.

**Stages are idempotent, because activities retry.** If the worker dies mid-stage, Temporal
reschedules that activity while the original `codex` process may still be running in the
pod. Each stage therefore keys off deterministic paths — a completed result file means the
stage is done and its output is returned; a live PID file means attach and wait rather than
restart; neither means run. Worker restarts become cheap instead of destructive.

**`implement` pushes its branch before finishing.** The branch is going to origin anyway,
and it makes GitHub the durable state between stages. A pod lost between `implement` and
`propose` costs a re-clone, not a redone ticket — which is why the sandbox needs no
persistent volume.

**`propose` opens the PR and stops.** It does not watch CI to a conclusion: a burst of
these PRs queues behind each other in Actions, and an activity blocked for hours on
external capacity couples this system to CI throughput while buying nothing a reviewer
can't see on the PR.

Models are per-stage config with a single default. v1 runs `gpt-5.6-terra` at `medium`
effort everywhere — the balanced tier, adequate for these tasks — with per-stage override
slots left empty. The seam costs nothing and the interesting tunings (flagship for
`implement`, cheap for `propose`, a *different* model for `review` so the adversarial pass
has different blind spots) become one-line changes once real timings exist.

## Auth: one refresh token, in exactly one place

Codex Access Tokens (`at-…`) — the non-rotating credential built for non-interactive use —
are Business/Enterprise only. On a personal Pro plan the only subscription credential is
the browser OAuth pair, whose refresh token is **single-use and rotating**. `codex-rs`
holds no cross-process lock around `auth.json`, only an in-process semaphore, so N
concurrent processes sharing one credential file eventually invalidate each other. This is
not speculative: it is openai/codex#10332, closed *not planned*, and OpenAI's own CI
guidance is "one `auth.json` per runner or per serialized workflow stream. Do not share the
same file across concurrent jobs or multiple machines."

The design avoids the race by ensuring **nothing but the worker ever holds a refresh
token**:

- The worker owns the real credential and is the only thing that refreshes it. It runs
  single-replica, so "single writer" is structural rather than enforced.
- Each sandbox gets its own ephemeral `CODEX_HOME` seeded with an `auth.json` carrying the
  current access token and an **empty** `refresh_token`.
- Codex only refreshes within five minutes of the access token's `exp`; measured tokens
  carry multi-day lifetimes, so a minutes-long ticket never approaches that window.
  Verified against v0.145.0: `codex exec` with a blanked `refresh_token` exits 0 and leaves
  the file byte-identical.

Because the CLI only refreshes inside that five-minute window and cannot be asked to do so
on demand, the worker performs the OAuth refresh itself.

Two traps this replaced, both found by reading the CLI's source rather than its docs:

**`CODEX_ACCESS_TOKEN` cannot carry an OAuth access token.** The env var and
`codex login --with-access-token` classify by prefix: `at-…` is a Personal Access Token,
anything else is treated as an Agent Identity JWT and must carry `agent_runtime_id` /
`agent_private_key` claims. A ChatGPT OAuth token has neither and fails to deserialize. The
credential must be written as a file into `CODEX_HOME`.

**`CODEX_HOME` is more than `auth.json`.** A run also creates `state_*.sqlite` with WAL
sidecars, `sessions/`, caches and logs. Concurrent processes sharing one corrupt that state
independently of auth. Per-pod ephemeral `CODEX_HOME` makes this a non-issue for free.

**Bootstrapping is a script, not SOPS.** The refresh token rotates on first use, so a value
stored in the vault is dead within a day and any later `pulumi up` recreating the Secret
would seed a corpse. `scripts/seed-codex-auth.sh` takes a local `codex login` and applies
it as a Kubernetes Secret out of band; Pulumi does not own that Secret. The *procedure* is
codified; the rotating value is not in git.

If the refresh token is revoked or expires, the service stops and says so. Recovery is one
`codex login` locally plus a re-seed — the only manual credential step in the system.

## Rate limits are the throughput constraint, not concurrency

The service draws on the same Pro-plan window as the owner's interactive sessions. Five
concurrent tickets do not finish more work than two; they reach the ceiling faster and then
contend with the human. Concurrency starts at 2 and moves only on measurement.

The larger lever is that five stages each re-explore the repository from cold. Richer
structured handoff — plans carrying concrete file paths, symbols and findings — reduces
re-exploration far more than parallelism increases throughput.

Hitting a limit is detected heuristically from the error message, since `codex exec --json`
exposes no structured rate-limit event, and trips a dispatcher-level circuit breaker that
stops starting new workflows for a cooldown. Without it every in-flight ticket burns its
retries into the same wall simultaneously.

## Observability

Per-stage token usage comes free in `turn.completed` and goes three places: Prometheus
counters labelled by stage and model (the cluster already runs Prometheus and Grafana), the
workflow result, and the issue's status comment so cost is visible where the work is
reviewed.

Full `--json` event streams are written per stage to `/transcripts/<ticket>/<run-id>/<stage>.jsonl`
on an NFS-backed volume, where `run-id` is Temporal's RunID so retries and re-runs stay
separately inspectable. Codex's own `thread_id` is recorded alongside for correlation. The
volume is mounted on the **worker**, not the sandbox: the worker pulls transcripts out of
the pod, so the sandbox holds nothing valuable and reaches nothing valuable.

Loki's 14-day retention is fine for logs and too short for transcripts, which is why they
are stored rather than shipped.

## Timeouts, retries and shutdown

Stages get 60 minutes each to start with, deliberately generous until real timings exist;
the workflow run timeout sits above their sum and `activeDeadlineSeconds` above that, so
Kubernetes never kills a pod Temporal still believes in. Activities heartbeat at 1 minute —
that is what makes a 60-minute activity cancellable rather than a black box. Cheap
activities (labels, comments, pod lifecycle) get short timeouts and more retries; stages get
few, because a retry is a full re-exploration and quota is the binding cost. Rate-limit and
auth failures are **non-retryable** — one trips the breaker, the other is dead until a human
re-seeds.

The worker drains on SIGTERM via `worker.Run(worker.InterruptCh())`, with
`terminationGracePeriodSeconds` above the drain window. Sandbox pods are deliberately **not**
cleaned up on shutdown; they are independent objects, and the reattach behaviour above means
a restarted worker resumes rather than redoes.

The Deployment is `replicas: 1` with `strategy: Recreate`. Two replicas would mean two
refreshers, and a rolling update over an RWO volume deadlocks (a failure mode this repo has
already hit).

## Blast radius

The worker holds a namespace-scoped `Role` — pods create/get/list/delete, `pods/exec`
create, `pods/log` get, secrets get/update — and nothing cluster-scoped. This is the first
pod in the cluster with Kubernetes API credentials at all; every existing Deployment sets
`automountServiceAccountToken: false` deliberately, and sandboxes continue to.

Sandboxes hold a GitHub App installation token (one hour, scoped to this repository)
because `implement` pushes a branch. Issue titles and bodies are attacker-controllable text
that reaches the sandbox as prompts and argv, so every `codex` invocation is built as an
explicit `[]string` and never interpolated into a shell string — end to end, including the
sandbox's own entrypoint.

## One nested directory, one Go module

`apps/software-factory/` holds the whole product: the Go module at its root and both images
under `images/`. This nests where every other `apps/*` entry is flat, and one module serves
what will be several binaries — both chosen for the same reason, that more components are
expected here and the alternatives are worse under growth. Flat siblings would spread
`software-factory-*` across `apps/`, and a module per component would fragment `internal/`
and the lint config before there is anything to fragment. Splitting a module later is
cheap; unsplitting is not.

The nesting is free because nothing in this repo globs `apps/*` — every CI path filter,
Dockerfile path and bun workspace is enumerated by name. It costs one thing: both images
sit behind the single path filter `apps/software-factory/**`, so a worker-only change
rebuilds the sandbox. Per-image filters were rejected as the expensive direction to be
wrong in — the two share the argv contract, and this repo has already shipped stale images
from digests that a filter did not catch.

## Go standards are scoped to this directory

`apps/software-factory/` carries its own `AGENTS.md`, `docs/SoftwareStyle.md` and
`.golangci.yml`, adapted from the separate `software-factory` repo's style guide. They
govern that tree — the Go module *and* the sandbox image, because the argv-only guarantee
spans both — and nothing else; the TypeScript side of this repo is untouched and
keeps following the root `AGENTS.md`. `docs/style-adoption.md` there records what was
adopted, what was translated (their logging targets a file because a TUI owns their
terminal; ours targets stdout for Loki) and what was skipped (their supervised-worker
primitive duplicates what Temporal already provides). Widening that scope later would be a
separate decision.

## Rejected

**API-key auth.** Sanctioned and simpler, and it would isolate this service's usage from the
owner's interactive quota entirely — but it moves spend from a flat subscription to metered
billing, which the owner declined.

**A hand-rolled polling daemon shelling out to an agent CLI.** The original sketch. Every
hard part — claim, crash recovery, retry, concurrency limiting, resumption after restart —
is something Temporal already does correctly, and the daemon version needed a jobs table
and reconciliation logic to approximate it badly.

**`temporal-community/sandbox-orchestration-harness`.** Encodes a good pattern — a child
workflow owning a sandbox's lifecycle, driven by updates — but it is a sample repo, none of
its five compute providers run on Talos, and its child-workflow indirection exists to serve
sandboxes shared across or outliving their creating workflow, which this design does not
have.

**A token broker handing short-lived credentials to many workers.** Effectively what this
design does, but the general form — where workers still hold refresh tokens and coordinate
— is unimplemented anywhere. Pi solves it with a same-machine file lock, opencode has not
solved it and carries open bugs, and OpenAI declined to fix it in the CLI.

**Per-slot credentials (N logins, N volumes).** The isolation-per-runner model OpenAI's
docs prescribe. Correct but strictly worse here: every increment of concurrency costs a
manual browser login forever, it needs a volume per slot, and it rested on the unverified
assumption that N logins from one account coexist. Injecting access-token-only credentials
achieves the same isolation with one login and no volumes.

## Consequences

A second language toolchain enters CI alongside the five mechanical touchpoints any new app
needs — path filter, build job, `needs:`, digest collection, `IMAGE_REPOSITORIES` — and
there are two images, the Go worker and the sandbox runner, so those touchpoints double.
`software-factory` becomes its own product via `defineProduct`, so its images are
`www-software-factory-*` rather than components of `control-center`.

The service depends on an undocumented behaviour: that `codex exec` accepts an `auth.json`
with an empty `refresh_token`. It is verified against v0.145.0 and consistent with the
CLI's refresh gating, but it is not a supported contract and a future release could tighten
it. Failure is loud — non-zero exit and `turn.failed` — never silent.
