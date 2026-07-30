# The software factory, end to end, as it is today

What actually happens when a ticket gets worked. Every claim here is read out of the code at
the cited line, not out of intent.

**This is not ADR-0011.** That document says why the system is shaped this way and was written
partly before the code existed. This one says what the code does now, including where it
diverges from that intent. Where the two disagree, this file is the report and the ADR is the
plan.

Read it to answer: what reads what, what can write, what is trusted for what, where a model
sits, where a human is required — and what is absent.

## One glance

```
GitHub issue labelled `auto`
        │
        │  dispatcher (one long-running Temporal workflow, polls every 30s)
        │  claim = Temporal workflow-ID uniqueness on `work-ticket-<n>`
        ▼
work-ticket-<n>  (one child workflow per ticket, ABANDON on parent close)
        │
        ├─ FetchTicketDetail ─────── issue title, body, comments
        ├─ CreateSandbox ─────────── one Pod running its own embedded worker,
        │                            emptyDir /work, per-ticket Secret mounted at auth.json
        ├─ WaitSandboxReady
        ├─ CloneRepo ─────────────── repo + git creds + gh hosts.yml + bot identity
        │
        │   ┌──────── the five stages, forward only, no loops, one Session ───┐
        ├───│  plan → review → revise → implement → propose                  │
        │   │  each = RunStage, a local `codex exec` inside the sandbox pod's │
        │   │  own embedded worker (cmd/sandbox-worker), same pod every stage │
        │   └─────────────────────────────────────────────────────────────────┘
        │
        ├─ FindPullRequest ───────── asks GitHub, not the model
        └─ finish (disconnected ctx): DeleteSandbox, ClearAutoLabel,
                                      outcome comment, signal dispatcher
        ▼
open PR ──► a human reads it, merges it, and thereby deploys
```

Nothing between `auto` and the open PR requires a human. Everything after it does.

## The control plane

### dispatcher

One workflow, ID `software-factory-dispatcher` (`work/paths.go`). A timer loop, not a Temporal
Schedule, because concurrency is `len(inFlight) < cap` against its own workflow state.

Each tick, in this order (`workflows/dispatcher.go:181` — the order is load-bearing):

1. `reconcile` — `DescribeWorkflowExecution` per in-flight ticket, a point lookup rather than a
   visibility search, releasing slots held by runs that died without signalling.
2. `pruneFinished`
3. `sweep` — deletes orphan sandbox pods older than the orphan grace.
4. `start` — if not paused and the breaker is closed, `ListAutoTickets` and claim up to the
   free slot count.

Claiming is `ExecuteChildWorkflow` with ID `work-ticket-<n>`. Temporal refuses a second open
run under one ID, so **starting the workflow *is* the claim** — no lease table. `claim` first
calls `DescribeRun` so a dispatcher that forgot a run adopts it instead of leaving it
uncounted (`dispatcher.go:339`).

Control surface is one signal and one query: `UpdateConfig` (nil means leave alone, so a deploy
and a human pause use the same path) and `GetStatus`.

Defaults (`work/control.go:85`):

| knob | value |
|---|---|
| max in flight | 2 |
| poll interval | 30s |
| breaker cooldown | 15m |
| orphan grace | 30m |
| model, all stages | `gpt-5.6-terra`, effort `medium` |

Per-stage model overrides exist as empty slots (`Config.ModelFor`, `control.go:125`).

### work-ticket-\<n\>

Setup, five stages, outcome, cleanup (`workflows/workticket.go:145`). Timing ladder
(`work/durations.go`, referenced not copied, because the inequalities are the invariant):

| bound | value |
|---|---|
| stage timeout | 60m |
| stage heartbeat timeout | 1m |
| stage attempts | **2** |
| run timeout | 6h |
| sandbox `activeDeadlineSeconds` | 7h |
| control activity timeout / attempts | 2m / 5 |

The heartbeat is what makes an hour-long activity cancellable rather than a black box. Its
source is the stage's own event stream — see *Trust and coupling* below.

## The five stages

Every stage is one `codex exec` in a fresh process with no memory of the others
(`clients/codex/argv.go:60`):

```
codex exec --json --dangerously-bypass-approvals-and-sandbox --cd /work/repo
  --model <name> -c model_reasoning_effort=<effort>
  --output-schema /work/<runid>/<stage>/schema.json
  --output-last-message /work/<runid>/<stage>/result.json
```

The prompt is delivered on **stdin** (`runner.go`'s exec passes it as the exec's stdin reader)
and separately written to `prompt.md` as the record of what was asked. It never reaches argv:
issue text is attacker-controllable, so every invocation is built as an explicit `[]string` and
nothing is interpolated into a shell string (`work/paths.go:194`).

| stage | reads | may write | trusted for | enforced how |
|---|---|---|---|---|
| `plan` | issue title/body/comments | nothing (read-only by instruction) | nothing downstream acts on directly | prompt only |
| `review` | the plan | nothing | finding real defects **in the plan** | prompt only |
| `revise` | plan + review | nothing | the document the implementer follows | prompt only |
| `implement` | revised plan | **the repo, and `git push`** | the code, and its own test evidence | prompt only |
| `propose` | implementation report + the branch/diff | **opens the PR via `gh`** | the PR body | prompt only |

"Read-only" for the first three stages is a **prompt instruction, not a capability**. Every
stage runs with `--dangerously-bypass-approvals-and-sandbox` in the same pod with the same
credentials. `plan` could write files and push; it is told not to.

### Naming

`review` reviews **the plan**. It runs before any code exists (`templates/review.md`: *"Review
the plan below adversarially… You are read-only. You cannot write files and you do not fix
anything"*). Sitting between `plan` and `revise` and named `review`, it reads as *the* review
step in the ordinary sense. It is not. Nothing in the pipeline reviews the diff.

### Handoff is prose, not data

ADR-0011 says a plan "travels as data, not as conversation". As of [#415][415]'s first wave,
each stage has its **own** schema (`templates/plan.schema.json` … `templates/propose.schema.json`)
instead of one shared envelope. `plan`, `review`, `revise` and `propose` still answer in one
string field:

```json
{ "document": { "type": "string", "description": "The stage's whole output, as markdown." } }
```

`implement` now also answers `blocked` (boolean) and `blocked_reason` (string), alongside its
`report` string. That is real structure at the content layer, not only the wire — but nothing
reads it yet. `implement.md` fills the fields, `prompts.Decode` constructs the typed
`work.ImplementOutput{Report, Blocked, BlockedReason}` from them, and it stops there: no stage's
prompt and no workflow code branches on `Blocked` in this step. The field exists so step 5's
`implement`/review loop can start reading it without inventing the schema-plus-Go-type mechanism
from scratch; wiring a reader now would be work step 5 immediately supersedes.

The carrier changed to match: a stage's output is `work.StageOutput`, a closed sum type over
`work.DocumentOutput` (plan/review/revise/propose) and `work.ImplementOutput` (implement) — never
a struct wide enough to hold both at once, so nothing downstream can read one stage's field off a
value another stage produced.

`Prior` carries **every** completed stage's output forward, not a rolling handoff
(`workticket.go`), keyed by stage — one slot per stage, last-write-wins, which is the whole
history on today's linear one-pass-per-stage pipeline. Each prompt injects only what it needs, via
a typed input struct per stage (`internal/prompts/input.go`) rather than a generic lookup table:
review gets the plan; revise gets plan + review; implement gets the revised plan; propose gets the
implementation report.

### Prompt injection defences that are in place

`templates/base.md` fences issue text in `<untrusted-issue-text-{{fence_nonce}}>` with a
per-run nonce, and every prior-stage document in `<untrusted-prior-document-…>`, with explicit
instructions that fenced content is data and cannot grant permissions or redirect the pipeline.
Every stage is told there is nobody to ask and that stalling to await input is a failure mode
(`base.md:9`).

## Where the model is, and where code is

Deliberate and worth reading as a pair:

**Code, never the model.** The run's outcome. `FindPullRequest` asks GitHub whether a PR exists
on `software-factory/ticket-<n>/<runid>` — a branch the worker named — rather than reading what
propose claimed (`workticket.go:238`):

> What the run achieved is asked of GitHub, never read out of what the propose stage said it
> did. […] letting it decide the outcome would let it decide the outcome.

**The model, though it needn't be.** Opening the PR at all. The worker's GitHub client has
`PullRequestForBranch` (`clients/github/github.go:233`) and **no create method** — the worker
cannot open a pull request. So propose exists because `gh pr create` in the sandbox was the
available write path, and body-writing was bundled into the same stage. Writing a body from a
diff is model work; opening a PR is an API call with no judgment in it.

**A trust inversion in propose.** `templates/propose.md:6` gates go/no-go on *"If the report
below says the work was not completed"* — the implementation report, which the same prompt
fences as untrusted at line 35. Its one objective check is "the branch has no commits ahead of
`main`", and commits existing is not the work being done. The workflow refuses to trust stage
text for the outcome; propose trusts it for the decision. **Unresolved by [#415][415]'s first
wave, deliberately**: `propose` is deleted entirely in step 5, as a stage and as a word, so
rewiring its prompt now would be thrown away almost immediately. The fix is deletion, not a patch
to a stage about to stop existing.

## Resumption

A stage has one resumption observation: the deterministic completion record
(`work/paths.go`):

| on disk in the sandbox | meaning |
|---|---|
| `result.json` present | stage is **done**; read it, never re-run |
| `result.json` absent | run |

#434 removed attach-and-wait: a Session-bound activity runs the stage as its own local
subprocess, so no separate running attempt exists for a retry to observe. The `result.json`
case is deliberately narrower. It covers an activity retry in the same Session after an earlier
attempt wrote its result but failed to report success, avoiding a duplicate paid Codex run.

One consequence is already visible in the data: a stage resumed from a stored result reports
`Usage` zero with `UsageMeasured: false` (`runner.go:170`), and **nothing reads
`UsageMeasured`** — its only non-test references are its assignment and its declaration. So
`status.go:431` renders `in 0 (0 cached) · out 0 · reasoning 0`, indistinguishable from a
measurement, and the run total silently under-reports by a whole stage. That is [#426][426].

## What the sandbox is

One Pod per ticket, `restartPolicy: Never`, running its own embedded Temporal worker
(`cmd/sandbox-worker`) that polls this run's per-ticket queue — not a batch job
(`clients/k8s/podspec.go:109`):

- `automountServiceAccountToken: false` — **no cluster access**
- `runAsNonRoot`, explicit uid, `allowPrivilegeEscalation: false`, `capabilities: drop ALL`
- one `emptyDir` at `/work` with a size limit; no persistent volume, no NFS mount
- `activeDeadlineSeconds` = 7h, above the run timeout so Kubernetes never kills a pod Temporal
  still believes in
- cluster-default `baseline` Pod Security (the namespace sets no label)

Layout inside (`work/paths.go`):

```
/work/repo                     the checkout
/work/.codex/auth.json         codex credential, refresh_token = ""
/work/.gh/hosts.yml            gh CLI credential
/work/<runid>/<stage>/         prompt.md, schema.json, result.json
```

**Credentials the agent can read.** `hosts.yml` holds the GitHub App installation token in
plaintext (`clients/k8s/clone.go:227`) alongside a git credential file. Containment inside the
pod is not achievable under the current security context; [#416][416] records that and that the
weakest of three options shipped knowingly. The token lives one hour against a run budgeted six,
and nothing refreshes it ([#417][417]).

**Toolchain gaps.** Final image stage is `debian:trixie-slim` with the Go toolchain copied in
(`images/sandbox/Dockerfile:70,153`); runtime apt is `ca-certificates curl git passwd procps
unzip`. No gcc, so `go test -race` cannot link; no `golangci-lint`. Both are what
`ci.yml:330` calls the authoritative gate for this tree, and factory-authored Go skips both
([#428][428]).

## Where a human is required

1. **Filing the ticket** and putting `auto` on it. The machine never adds that label.
2. **Reviewing the PR.** Nothing else does.
3. **Merging**, which deploys. `templates/propose.md:25`: *"Do not wait for CI. Do not merge. Do
   not close the issue. `AGENTS.md` pre-approves self-merging a green pull request; that does not
   apply to this pipeline."*
4. **Re-adding `auto`** for another pass. The machine removes it on every ending except
   cancellation — including a hard failure, because leaving it on means the dispatcher relists
   and refails the ticket forever (`workticket.go:296`).
5. **Re-seeding the codex credential** if the refresh token dies. The only manual credential
   step; `scripts/seed-codex-auth.sh`, deliberately not in SOPS because the value rotates on
   first use.

## What is absent

Not defects to be fixed here — the absences a decision has to be made about, stated plainly so
they are visible in one place.

- **Nothing reviews the code.** The plan gets a dedicated adversarial fresh-eyes stage; the diff
  gets none. The failure mode "plan was right, implementation drifted" has nothing looking for
  it. `implement` self-verifies (`templates/implement.md:15` mandates test-first and requires
  real command output as evidence) — that is the author checking their own work, which is
  precisely what `review` exists to avoid for plans.
- **Nothing observes CI.** propose is told not to wait. A run reports `proposed` and frees its
  slot without learning whether the branch builds.
- **No loop back.** `base.md:5`: *"It runs forward, once. Nothing loops back."* There is no path
  from a red result, a review finding, or a changes-requested review to another attempt.
  Re-work means a human re-adds `auto`, which starts a **fresh run from `plan`** with a new run
  ID and a new branch.
- **Structured stage output only partly landed.** [#415][415]'s first wave gave each stage its own
  schema and gave `implement` a real `blocked`/`blocked_reason` pair, but nothing reads either
  field yet, and `plan`/`review`/`revise`/`propose` still answer in one prose string apiece — see
  "Handoff is prose, not data" above.
- **No per-stage capability enforcement.** Read-only is prose.
- **No network isolation.** Flannel implements no policy engine; the cluster has zero
  NetworkPolicies. An egress allowlist would be a no-op file.
- **`MaximumAttempts: 2` per stage**, and a worker rollout consumes one. Two rollouts inside one
  stage fail the run even though the work is intact in the sandbox.

## Where the records are

| record | where |
|---|---|
| what a run decided, and why | Temporal history, `software-factory` namespace, 10y retention |
| raw event stream per stage | `<transcripts>/<ticket>/<runid>/<stage>.jsonl`, NFS, mounted on the **worker** only |
| human-facing progress | one status comment per step on the issue, edited in place per `(run, step)` |
| tokens and outcomes | Prometheus counters by stage and model, the workflow result, the outcome comment |
| worker logs | Loki, 14d — which is why transcripts are stored rather than shipped |

The worker's *mount* is scoped to a transcripts subtree (`subPath`,
`infra/src/software-factory.ts:521`), but the *PersistentVolume* behind it is provisioned
against the whole NFS export — which also holds cluster backups and media ([#412][412]).

## Open tickets this map makes legible

- **[#424][424]** — liveness and transcript coupled to a stream from a constantly-redeploying pod.
- **[#425][425]** — every stage shows as `RunStage` in the Temporal UI; stage identity is
  payload-only.
- **[#426][426]** — a resumed stage reports 0 tokens as though measured.
- **[#428][428]** — the sandbox image now carries what both need (gcc/libc6-dev for
  `-race`, a pinned `golangci-lint`), landed by #440; still open because nothing has yet
  run either gate inside a live sandbox.
- **[#415][415]** — per-stage schemas and a typed input seam landed; nothing acts on `implement`'s
  new `blocked`/`blocked_reason` fields yet, and the other four stages still carry one prose
  field. Step 5 is expected to wire it up as part of the pipeline redesign.
- **[#416][416]**, **[#417][417]** — the sandbox's GitHub token: readable, and expires mid-run.
- **[#412][412]** — the transcripts PV is provisioned against the whole NFS export; the
  worker's own mount is already `subPath`-scoped.
- **[#331][331]** — status comment renders `in` as a loop total including the cached part.

Unfiled, and named in *What is absent* above: no diff review, no CI observation, no loop back,
propose's trust inversion.

[331]: https://github.com/0x63616c/world-wide-webb/issues/331
[411]: https://github.com/0x63616c/world-wide-webb/issues/411
[412]: https://github.com/0x63616c/world-wide-webb/issues/412
[413]: https://github.com/0x63616c/world-wide-webb/issues/413
[415]: https://github.com/0x63616c/world-wide-webb/issues/415
[416]: https://github.com/0x63616c/world-wide-webb/issues/416
[417]: https://github.com/0x63616c/world-wide-webb/issues/417
[423]: https://github.com/0x63616c/world-wide-webb/issues/423
[424]: https://github.com/0x63616c/world-wide-webb/issues/424
[425]: https://github.com/0x63616c/world-wide-webb/issues/425
[426]: https://github.com/0x63616c/world-wide-webb/issues/426
[428]: https://github.com/0x63616c/world-wide-webb/issues/428
