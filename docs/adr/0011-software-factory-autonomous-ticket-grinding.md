# Software factory: autonomous ticket grinding in sandboxed pods

Tickets labelled `auto/todo` are picked up, planned, reviewed, implemented and turned into open
PRs by a self-hosted service — no human in the loop until the PR exists. It runs as a Go Temporal
worker in a new `software-factory` k8s namespace on its own `software-factory` Temporal namespace
and task queue, and executes each ticket's agent stages via `codex exec` inside a disposable
per-ticket pod. Merging the resulting PR — and therefore deploying — stays a human act.

This replaces `.claude/workflows/grind-tickets.js`, which is deleted. That workflow required a
human to launch it with an explicit ticket list, ran agents in the operator's own session against
the operator's own checkout, and serialised its PR-opening phase behind a barrier that made one
slow ticket delay every other ticket's PR.

## Why not the existing Temporal worker

`apps/temporal-worker` is deliberately single-namespace, single-task-queue (ADR-0008), and its
workflow set is glob-collected from `features/<id>/temporal.ts` facets. Ticket grinding is not app
work: it has no feature, no tile, no place in the `control-center` namespace, and its activities
need the k8s API rather than the product database. It gets its own worker, its own namespace, and
hand-registered workflows. `infra/src/temporal.ts` is the precedent — a standalone worker owning
its own namespace, written as plain k8s objects rather than the `Workload` component.

Go, not TypeScript. Everything this service touches — Temporal, `client-go`, the k8s API — is
Go-native, and it shares no code with the monorepo. The cost is a second toolchain in CI.

## Claim semantics come from Temporal, not from a lock

Each ticket's workflow ID is `grind-ticket-<n>`. Temporal refuses to start a second workflow with
an open run under the same ID, so starting one unconditionally *is* the claim — there is no lease
table, no advisory lock, and no distributed coordination to get wrong. The `auto/*` labels are
human-visible status, not correctness.

Two consequences that are easy to get wrong:

**Grind workflows are started as independent top-level workflows from a poller activity, not as
children of the poller.** A child workflow's default `ParentClosePolicy` is `TERMINATE`; a
scheduled poller that finishes in two seconds would kill every grind run it had just started.
Starting them via the Temporal client from inside an activity avoids parent-close semantics
entirely and keeps each run independently visible.

**A workflow that dies without running its cleanup leaves the ticket stuck in `auto/claimed`,
where the poller's `auto/todo` query will never see it again.** The poller therefore also
reconciles: for each `auto/claimed` issue it checks whether `grind-ticket-<n>` has an open run and,
if not, returns the ticket to `auto/todo`. This is the one piece of reconciliation the design
genuinely needs; everything else falls out of workflow-ID uniqueness.

## Sandboxes are plain Pods

One pod per ticket, named `grind-<n>`, `restartPolicy: Never`, `activeDeadlineSeconds` as a hard
ceiling, CPU/memory limits, `automountServiceAccountToken: false`, and a `sleep infinity`
entrypoint — it is a session that stages exec into, not a batch job. Stage execution is the
standard `pods/exec` subresource, which streams and returns a real exit code.

`kubernetes-sigs/agent-sandbox` was evaluated and rejected for now. Its `Sandbox` CRD is a
lifecycle wrapper around a Pod — stable identity, `volumeClaimTemplates`, `operatingMode:
Suspended`, `shutdownTime` — and it is explicitly *not* an isolation boundary; isolation is
delegated to a `RuntimeClass`. Everything it would give us here is already a Pod field
(`activeDeadlineSeconds`) or a static namespace-wide object (one NetworkPolicy selecting
`app=grind-sandbox`), and its warm pools, suspend/resume and Go SDK are all features this design
does not use. Against that: v0.5.x, a live `v1alpha1`→`v1beta1` conversion-webhook migration,
breaking changes across recent point releases, and ~817 KB of CRDs on the cluster that runs the
house. Adopt it the day warm pools or gVisor are actually wanted — the workflow code is unchanged
either way, only the activity that creates the thing differs.

gVisor is likewise deferred. Talos ships system extensions baked into the boot image, so adding
`runsc` changes the schematic ID and requires `talosctl upgrade` — a reboot of the single
control-plane node, i.e. taking the house down. The threat it would mitigate is real but
addressable more cheaply: the untrusted code here is not the model, it is the arbitrary npm
postinstall scripts that `bun install` executes on every single ticket. A namespace NetworkPolicy
that allows egress to github.com, the OpenAI API and the npm registry while denying
`192.168.0.0/16` blocks the exfiltration path without rebooting anything, and matters more than
syscall filtering on a single-tenant cluster running its owner's own tickets.

## Stages, and why each is a separate `codex exec`

`plan → review → revise → implement → propose`, each its own Temporal activity with its own
timeout and retry policy, and each its own `codex exec` invocation. A fresh invocation is a fresh
thread, which is the point: the adversarial reviewer must not share context with the planner, and
process boundaries enforce that better than prompt instructions. Handoff between stages is
structured — `--output-schema` constrains the final message to a JSON Schema and `-o` writes it to
a file the worker reads out of the pod — so the plan travels as data, not as conversation.

Success and failure are read from the process exit code and the `turn.failed` / top-level `error`
events in `--json` output. Both are load-bearing in the CLI's own source; neither requires parsing
human-readable text.

Model and reasoning effort are per-stage config, not constants. `implement` and `plan` want the
flagship at high effort; `propose` is rebase-push-open-PR and runs fine on the cheap model; and
`review` deliberately runs a *different* model from `plan` so the adversarial pass has different
blind spots. This is a quota decision as much as a quality one — see below.

**Stages must be idempotent, because activities retry.** If the worker dies mid-stage, Temporal
reschedules that activity on a new worker while the original `codex` process may still be running
in the pod. Each stage therefore begins by killing stragglers and resetting the workspace to the
last commit before doing anything. Where the pod itself is gone, the retry recreates it and
re-clones.

**`implement` pushes its branch to origin before finishing.** The branch is going there anyway, and
it makes GitHub — not an emptyDir, not a volume — the durable state between stages. A pod lost
between `implement` and `propose` costs a re-clone, not a redone ticket. This is why the sandbox
needs no persistent volume at all.

**`propose` opens the PR and stops.** It does not watch CI to a conclusion. A burst of grind PRs
queues behind each other in Actions, and an activity blocked for hours on an external system is
both a bad Temporal citizen and a coupling to CI capacity that buys nothing — the human reviewing
the PR sees CI status anyway.

## Auth: one refresh token, in exactly one place

Codex Access Tokens (`at-…`) — the non-rotating credential built for non-interactive use — are
[Business/Enterprise only](https://learn.chatgpt.com/docs/enterprise/access-tokens). On a personal
Pro plan the only subscription credential is the browser OAuth pair, whose refresh token is
**single-use and rotating**: a refresh returns a new refresh token and invalidates the old one.
`codex-rs` holds no cross-process lock around `auth.json` — only an in-process semaphore — so N
concurrent processes sharing one credential file will eventually invalidate each other. This is
not speculative: it is [openai/codex#10332](https://github.com/openai/codex/issues/10332), closed
*not planned*, and OpenAI's own CI guidance is "one `auth.json` per runner or per serialized
workflow stream. Do not share the same file across concurrent jobs or multiple machines."

The design avoids the race by ensuring **nothing but the worker ever holds a refresh token**:

- The worker owns the real credential and is the only thing that ever refreshes it. It runs
  single-replica, so "single writer" is structural rather than enforced.
- Each sandbox gets its own ephemeral `CODEX_HOME` seeded with an `auth.json` containing the
  current access token and an **empty** `refresh_token`.
- Codex only refreshes within five minutes of the access token's `exp`; measured tokens carry
  multi-day lifetimes, so a sandbox running a minutes-long ticket never approaches that window and
  never attempts a refresh. Verified empirically against v0.145.0: `codex exec` with a blanked
  `refresh_token` exits 0 and leaves the file byte-identical.

Two traps this replaced:

**`CODEX_ACCESS_TOKEN` cannot carry an OAuth access token.** The env var and
`codex login --with-access-token` both classify by prefix: `at-…` is a Personal Access Token,
anything else is treated as an Agent Identity JWT and must carry `agent_runtime_id` /
`agent_private_key` claims. A ChatGPT OAuth access token has neither and fails to deserialize. The
credential must be written as a file into `CODEX_HOME`.

**`CODEX_HOME` is not just `auth.json`.** A run also creates `state_*.sqlite` (with WAL
sidecars), `sessions/`, caches and logs. Concurrent processes sharing a `CODEX_HOME` corrupt that
state independently of auth — the real cause behind several "database is locked" reports
downstream. Per-pod ephemeral `CODEX_HOME` makes this a non-issue for free.

The worker performs the refresh itself (an OAuth `grant_type=refresh_token` POST) rather than
driving the CLI, because the CLI only refreshes inside the five-minute window and cannot be asked
to do it on demand. Rotated credentials are persisted to a worker-owned k8s Secret — created by
Pulumi with `ignoreChanges` on its data and seeded from SOPS, so an unrelated `pulumi up` cannot
overwrite a live token with the stale original. The Deployment uses `strategy: Recreate`; a
rolling update would briefly run two refreshers.

If the refresh token is ever revoked or expires, the service stops and says so. Recovery is one
`codex login` locally plus a re-seed. That is the accepted operational cost of subscription auth,
and it is the only manual credential step in the system.

## Rate limits are the throughput constraint, not concurrency

The grinder draws on the same Pro-plan window as its owner's interactive sessions. Five concurrent
tickets do not finish more work than two — they reach the ceiling faster and then contend with the
human. Concurrency starts at 2 and moves only on measurement.

The larger lever is that five stages each re-explore the repository from cold. Richer structured
handoff (plans carrying concrete file paths, symbols and findings) reduces re-exploration far more
than parallelism increases throughput.

Hitting a limit is detected heuristically — the error message, since `codex exec --json` exposes no
structured rate-limit event — and trips a poller-level circuit breaker that stops starting new
workflows for a cooldown. Without it, every in-flight ticket burns its retries into the same wall
simultaneously.

## Blast radius

The worker holds a namespace-scoped `Role` — `pods` create/get/list/delete, `pods/exec` create,
`pods/log` get, `secrets` get/update — and nothing cluster-scoped. This is the first pod in the
cluster with k8s API credentials at all; every existing Deployment sets
`automountServiceAccountToken: false` deliberately, and sandboxes keep doing so.

Sandboxes hold a GitHub App installation token (one hour, scoped to this repository) because
`implement` pushes a branch. Combined with the npm-postinstall vector, that is the credential worth
protecting, and the egress allowlist above is what protects it.

## Rejected

**API-key auth.** Sanctioned, simpler, and it would isolate the grinder's usage from the owner's
interactive quota entirely — but it moves spend from a flat subscription to metered billing, which
the owner declined.

**A hand-rolled polling daemon shelling out to an agent CLI.** The original sketch. Every hard part
— claim, crash recovery, retry, concurrency limiting, resumption after restart — is something
Temporal already does correctly, and the daemon version would have needed a jobs table and
reconciliation logic to approximate it badly.

**`temporal-community/sandbox-orchestration-harness`.** Encodes a genuinely good pattern (a
child workflow owning a sandbox's lifecycle, driven by updates), but it is a sample repo, none of
its five compute providers run on Talos, and its child-workflow indirection exists to serve
sandboxes shared across or outliving their creating workflow — which this design does not have.
Worth reading, not depending on.

**A token broker handing short-lived credentials to many workers.** This is effectively what the
design does, but the general form — where workers still hold refresh tokens and coordinate — is
unimplemented anywhere. Pi solves the same problem with a same-machine file lock, opencode has not
solved it and carries open bugs, and OpenAI declined to fix it in the CLI.

**Per-slot credentials (N logins, N volumes).** The isolation-per-runner model OpenAI's docs
prescribe. Correct but strictly worse here: every increment of concurrency costs a manual browser
login forever, it needs a volume per slot, and it rests on the unverified assumption that N logins
from one account coexist. Injecting access-token-only credentials achieves the same isolation with
one login and no volumes.

## Consequences

A second language toolchain enters CI (Go build, test, lint) alongside the five mechanical
touchpoints any new app needs: path filter, build job, `needs:`, digest collection, and an
`IMAGE_REPOSITORIES` entry. `software-factory` becomes its own product via `defineProduct`, so its
images are `www-software-factory-*` rather than components of `control-center`.

The `auto` label is renamed `auto/todo` and joined by `auto/claimed` and `auto/blocked`. This is a
deliberate exception to the "exactly one `area/*` and one `type/*`, nothing else" rule in
AGENTS.md: these encode machine state that a machine maintains and clears, not human status that
goes stale.

The service depends on an undocumented behaviour — that `codex exec` accepts an `auth.json` with
an empty `refresh_token`. It is verified against v0.145.0 and consistent with the CLI's refresh
gating, but it is not a supported contract and a future release could tighten it. Failure is loud
(non-zero exit, `turn.failed`), never silent.
