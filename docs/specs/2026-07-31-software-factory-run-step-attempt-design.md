# Software factory Run, Step, and Agent Attempt design

Status: **working design**

Behavior companion:
[Software factory v0 acceptance-test contract](./2026-07-31-software-factory-v0-acceptance-test-contract.md)

Behavior companion:
[v0 acceptance-test contract](./2026-07-31-software-factory-v0-acceptance-test-contract.md)

This document records the software factory lifecycle design discussion as of
2026-07-31. It is intentionally not yet an ADR. The v0 completion boundary is
now fixed at a confirmed merge; the remaining questions concern implementation
boundaries and infrastructure failure policy rather than deployment waiting.

## Scope

The immediate change is to remove the human approval gate from successful
factory Runs. After a clean internal review, the workflow will mark the pull
request ready and explicitly ask GitHub to merge the exact reviewed head SHA.

This document focuses on the durable Run history needed around that flow:

- one model of Steps for both agent work and infrastructure work;
- a precise distinction between Temporal activity retries and Agent Attempts;
- meaningful activity names in Temporal;
- complete enough Postgres history that the console does not need to query
  Temporal for state.

Automated revert, rollback, and fix-forward policy are outside this design.
Semantic conflicts are also outside it. Textual merge conflicts remain in
scope because they can prevent the workflow from completing its merge.
An optional human-approval mode is also outside this version. Successful Runs
are fully unattended.

## Provisional assumption register

These are the premises currently underneath the design, including premises
that the implementation must make true. They are written explicitly so they
can be aligned with the product owner and then attacked by a fresh-context
critic. They are not additional settled decisions merely because they appear
here.

### Non-technical assumptions

- **Agreed: admission is authorization.** Any Ticket admitted to the factory is safe
  to take through an unattended merge; v0 needs no separate per-Ticket human
  approval switch.
- **Agreed: internal review is sufficient.** A clean independent agent Review Step,
  following green CI for the same head SHA, is enough product authorization to
  request the merge.
- **Agreed: Ticket design handles semantic ordering.** Ticket dependencies and how work
  is decomposed are expected to prevent known semantic conflicts. The runtime
  design only promises to detect and repair textual Git merge conflicts.
- **Agreed: merged is done.** A confirmed merge is useful enough to satisfy dependency
  edges even though production deployment has not been observed. Later deploy
  failure neither reopens the Ticket nor retroactively changes its result.
- **Post-merge repair is new work.** If merged code later proves broken, a
  future mechanism creates or selects a new repair Ticket; v0 does not revert,
  roll back, or resume the completed Run.
- **Squash is universal.** Factory-authored pull requests need no merge strategy
  other than squash.
- **Agreed: cancellation means retryable interruption.** Canceling the dispatcher owns
  and cancels its current Runs. A canceled Run returns its still-owned Ticket
  to `open`, rather than classifying the Ticket itself as failed.
- **Pause preserves work.** Operators who want dispatch to stop without
  interrupting current Runs will pause or drain the dispatcher, not cancel it.
- **The agreed budgets are affordable.** Five Review Steps and 25 total Agent
  Attempts are acceptable upper bounds for cost and elapsed time in one Run.
- **Rare drain pauses are acceptable.** Temporarily admitting no new Tickets
  while a dispatcher drains before `ContinueAsNew` is an acceptable throughput
  tradeoff.

### Technical assumptions

- **Agreed: GitHub authorization will change.** The GitHub App and repository ruleset
  can be changed so the App may merge without a Code Owner approval while the
  intended CI protections still apply. This is not true of the current setup,
  whose App deliberately lacks bypass authority.
- **GitHub can enforce the reviewed head.** The merge request supplies the
  reviewed head SHA, and only an authoritative `merged: true` observation plus
  a merge SHA proves success. After an ambiguous response, reconciliation uses
  GitHub's merged endpoint or GraphQL `merged` plus `mergeCommit`; a closed PR
  or populated REST `merge_commit_sha` alone is not proof.
- **Agreed: verdicts are SHA-scoped.** CI and internal review results can be associated
  with an exact PR head. Any head change invalidates those verdicts and sends
  the new head through CI and review again.
- **Merge refusal is classifiable.** GitHub responses and follow-up reads give
  enough information to distinguish a textual conflict, a changed head, an
  already-completed merge, a ruleset or permission rejection, and a transient
  infrastructure failure.
- **Run Worker affinity is real.** Within one worker generation,
  `CreateSession` on its private task queue pins every activity to that exact
  worker and filesystem. Permanent loss may create one replacement generation
  from the same pinned image and durable Step boundary.
- **The Run Worker can hold the required execution capabilities.** It can
  execute Git, Codex, GitHub, CI observation, and merge activities without
  Kubernetes exec or remote file copying. Claim, durable recording,
  finalization, provisioning, and cleanup remain main-control activities so
  Session loss cannot remove the workflow's recovery path.
- **Rotated credentials reach live processes.** A GitHub installation token can
  be refreshed before every Agent Attempt and every 30 minutes during an active
  Attempt, and the agent-facing Git process will use the new value without
  putting the token in Temporal history.
- **Durable boundaries are idempotent.** Ticket claims, Step and Attempt
  recording, PR synchronization, merge reconciliation, terminal recording,
  dependency satisfaction, and cancellation finalization all have stable
  identities or ownership checks that make activity retries safe.
- **Cancellation finalization can be atomic.** Postgres can conditionally mark
  the owning Run canceled and move only its still-`active` Ticket to `open`, so
  a late cancellation cannot reopen a Ticket already committed as `done`.
- **Agreed: a repeated Run supersedes existing Git state.** After cancellation
  reopens a Ticket, the next Run owns a fresh branch and pull request, carries
  useful commits forward, and prevents the old unmerged pull request from
  remaining merge-authorized.
- **Expected waiting belongs in activity retry state.** `AwaitDispatchableTickets`
  and `AwaitCI` can use retryable waiting results without producing workflow
  history per poll or operational-error noise.
- **Draining has bounded work.** Temporal's `GetContinueAsNewSuggested()`
  arrives with enough headroom for the finite set of already-started children
  and a bounded number of policy Updates. Once draining begins, duplicate
  policy publications are rejected as already current and non-duplicate
  publications are capped. Later changes receive a typed `DRAINING` rejection
  and retry against the continued execution, so waiting on long-lived children
  adds no unbounded parent history and does not cancel those children.
- **Parent cancellation is cooperative.** `REQUEST_CANCEL` lets each
  `WorkOnTicket` run its disconnected finalization. Direct child termination
  remains exceptional and relies on reconciliation plus orphan cleanup because
  terminated workflow code cannot finalize itself.
- **The merge webhook is not authoritative for v0 completion.** Removing the
  factory's pull-request-closed completion consumer does not remove another
  required behavior; the relay infrastructure can remain without that event.
- **Deployment is outside the Run's consistency boundary.** Nothing needed to
  mark a Ticket `done` depends on a production rollout signal.
- **Old workflow compatibility is intentionally excluded through cutover.** No
  redesigned command sequence uses `workflow.GetVersion`. Before deployment,
  an operator runbook pauses admission, disables auto-merge on every old
  factory PR, cancels or terminates every old Ticket Run and the old
  dispatcher, reconciles each nonterminal Ticket back to `open`, and proves no
  pre-redesign execution remains open. Only then may the new worker deploy.

## Established surrounding direction

The current direction for the merge flow is:

1. Run the existing implement, CI, and internal-review loop.
2. After a clean review, mark the pull request ready.
3. Explicitly call GitHub's merge API with the reviewed head SHA and
   `merge_method: squash`. Squash is the only supported merge method.
4. Treat only an HTTP success response with `merged: true` and a returned merge
   SHA as a confirmed merge.
5. Re-read authoritative merged state after an ambiguous response so a lost
   response does not cause the workflow to guess. Closed state alone is not a
   successful merge.
6. If the head changed, rerun CI and internal review for the new head.
7. If GitHub reports a textual conflict, return to implementation, merge the
   latest `main` into the branch, resolve the conflict, rerun CI and review, and
   attempt the merge again.
8. After a confirmed merge, durably record the merge SHA, end the Run
   successfully, mark the Ticket `done`, and satisfy its dependency edges.

The merge-conflict path remains inside the same Run. It does not create a new
Run, replace the Run Worker, or reset any cumulative budget.

The GitHub pull-request webhook is not needed for the normal successful path if
the workflow performs and confirms the merge itself. The shared webhook relay
can remain for future events, while the factory's current pull-request-closed
completion path can be retired separately.

The coarse Ticket-state direction is:

```text
open -> active -> done
            \-> failed

failed -> open   (manual retry)
```

`review` is removed because there is no longer a human waiting state. In v0,
`done` means GitHub has confirmed the merge and returned its merge SHA. It does
not mean the change has deployed.

## One active Run Worker at a time

This is decided:

> The `WorkOnTicket` workflow provisions one active Run Worker, creates a
> Temporal Session with it immediately, and executes every filesystem- or
> repository-affine Run activity from repository clone through merge on that
> worker. Mandatory Store recording and terminal finalization remain available
> on the main worker. Permanent
> worker loss creates a replacement from the same pinned image and resumes
> after the latest durable Step boundary.

`Run Worker` replaces `Sandbox` in the target vocabulary. The pod is not a
restricted place into which the main worker remotely executes selected agent
commands. It is the Run's execution worker: it owns the checkout, tools,
credentials, local process handles, and activity implementations while that
worker generation is active. A Run normally has one generation. Replacement
is recovery inside the same Run, never permission to run two generations
concurrently or to adopt a newly deployed image.

The target flow is:

```text
Dispatcher
  starts WorkOnTicket

Main worker
  claim Ticket
  create Run Worker pod
  CreateSession on the Run's private task queue
        |
        v
Run Worker generation, fixed image
  clone repository
  plan / implement / review
  sync pull request
  await CI
  mark pull request ready
  merge pull request
        |
        |     main-control activities persist every Step/Attempt boundary,
        |     refresh the projected credential Secret, and finalize outcomes
        |
        +-- permanent worker loss
        |     main worker deletes/sweeps the lost generation
        |     creates a replacement from the same image
        |     creates a new Session
        |     restores Git and durable Step state
        |     resumes after the latest completed Step
        |
        v
Main worker
  atomically record confirmed merge, Run success, and Ticket done
  CompleteSession
  delete Run Worker
  perform fallback cleanup
```

The Ticket claim and Run creation are one Store transaction that establishes
an explicit `active_run_id` ownership token before provisioning, so two racing
Runs cannot both create workers and a stale Run cannot finalize a later one's
Ticket. Provisioning, mandatory Store boundaries, terminal/cancellation
finalization, credential-Secret rotation, and cleanup remain on the main
worker because they must survive Session loss. Filesystem- and
repository-affine operations between successful Session creation and Session
completion use a context derived from `sessionCtx`.

`CreateSession` does not create a Kubernetes pod and does not inspect
Kubernetes readiness. Our code creates the pod, derives
`RunWorkerTaskQueue(runID)`, and supplies that queue both to the pod and to
`CreateSession`. The Run Worker's embedded Temporal worker starts polling that
queue with Sessions enabled. Temporal then schedules its internal
session-creation activity, waits up to `CreationTimeout` for the worker to
claim it, and returns a Session context whose activities are routed to that
exact worker. A separate `WaitRunWorkerReady` activity is unnecessary: the
Session handshake proves the capability the workflow actually needs, namely
that the embedded worker is connected to Temporal and accepting work.

The conceptual workflow shape is:

```go
func WorkOnTicket(ctx workflow.Context, in WorkOnTicketInput) (WorkOnTicketResult, error) {
    control := workflow.WithActivityOptions(ctx, provisioningOptions(in.Policy))

    ticket, durable, err := claimTicketAndStartRun(control, in.TicketID)
    if err != nil {
        return WorkOnTicketResult{}, err
    }

    for generation := 1; ; generation++ {
        workerID := createRunWorker(control, in, generation)
        sessionCtx := createRunWorkerSession(ctx, in, generation)

        result, runErr := executeRunFrom(ctx, sessionCtx, in, ticket, durable)
        workflow.CompleteSession(sessionCtx)
        deleteRunWorker(ctx, workerID)

        if !isPermanentSessionLoss(runErr) {
            return result, runErr
        }
        durable = loadRunPosition(control, in.TicketID)
    }
}
```

`executeRun` derives each Step's activity options from `sessionCtx`. Different
Steps retain their own timeouts and retry policies, while Temporal overrides
their destination with the Session's worker-specific queue.

The `WorkOnTicket` workflow function remains registered on the main Temporal
worker. The Session pins its activities, not its workflow tasks. A main-worker
deploy can therefore replay the deterministic orchestration code, but it
cannot replace an active Run Worker's activity implementations or interrupt a
long-running activity merely by rolling the main worker Deployment.

Permanent Run Worker loss is different from a main-worker deploy. Session
failure returns control to `WorkOnTicket`, which creates a new worker generation
from the Run Policy's same pinned image, reconstructs the branch from durable
Git state, and resumes after the latest completed Step. Completed Steps and
cumulative budgets never reset. If the interrupted Agent Attempt cannot be
resumed from durable provider state, it ends failed and a new Agent Attempt may
be authorized inside the same Step only while the existing Run-wide budget
allows it. Making implementer thread state recoverable across a fresh
filesystem remains an implementation prerequisite rather than an assumption
that local files survived.

The Run Worker registers clone, agent execution, pull-request synchronization,
GitHub reads/writes, CI waiting, readying, and merge. The main worker registers
dispatcher, claim/record/finalize, credential-Secret rotation, provisioning,
and cleanup activities. Clone and file operations execute locally, so the
remaining Kubernetes `pods/exec` and remote file-transfer machinery can be
removed only during the final quiesced activation. Additive Run Worker releases
must retain them and the legacy sandbox image for still-live old workflows.

All agent stages receive the same writable working environment. Plan and
review may remain semantically read-only through their prompts, but this is
not enforced by separate filesystem partitions. Codex already runs with its
own approvals and sandbox bypassed; the Run Worker pod, resource limits,
credentials, and network policy are the execution boundary. It receives no
database credential or GitHub App private key.

## Core model

The clean design is:

> A Step is executor-neutral. An Agent Attempt is one workflow-authorized agent
> execution of one agent-backed Step. A Temporal activity retry is not an Agent
> Attempt, and a Codex thread is a separate identity from both.

Infrastructure Steps do not get synthetic Attempt records. A transient network
failure while merging, cloning, or observing CI is handled by Temporal's native
activity retry policy inside the same Step.

```text
Ticket
  Run
    Step
      AgentAttempt, when applicable
        Transcript, when applicable
```

Conceptually:

```sql
step
  run_id
  ordinal
  kind
  iteration
  reason
  state
  started_at
  ended_at
  result_code

agent_attempt
  step_id
  attempt_no
  state
  started_at
  ended_at
  failure_kind
  agent_stage
  model
  effort
  usage_state
  input_tokens
  cached_input_tokens
  output_tokens
  reasoning_tokens
  thread_id

transcript
  agent_attempt_id
  ...
```

An infrastructure Step has no Agent Attempt rows. An agent-backed Step gets one
row each time the workflow deliberately starts a whole agent run.

For example:

```text
Step: prepare_run_worker
  Activity try 1: transient Kubernetes error
  Activity try 2: succeeded
  Agent Attempts: none

Step: implement, iteration 1
  Agent Attempt 1: failed and cannot be resumed
    Agent: gpt-5.6-terra / medium
    Thread: inherited from an earlier implement Step, when applicable
    Usage: unknown
  Agent Attempt 2: succeeded by starting over
    Agent: gpt-5.6-terra / medium
    Thread: fresh
    Usage: measured
    Transcript: available
```

The existing `measured` flag should become an explicit usage state:

- `measured`: the agent ran and usage was captured;
- `unknown`: it may have run, but some or all usage was lost.

Agent Attempt identity is scoped to its Step. A new agent-backed Step starts at
Agent Attempt 1 even when it deliberately resumes the implementer's Codex
thread from an earlier Step. Within that Step, technical activity retries that
recover the same authorized execution remain the same Agent Attempt. The
workflow creates Agent Attempt 2 only when it authorizes another execution of
the same Step after Agent Attempt 1 failed. One Agent Attempt may therefore
span more than one process or Temporal activity try.

## Step identity

The current Step key is `(run, stage, turn)`, so it can represent only the
three agent stages. That restriction exists in both the schema and
`internal/work.StageKey`.

Replace that identity with:

```text
StepKey = Run ID + ordinal
```

The workflow generates monotonically increasing ordinals:

```text
 1 prepare_workspace
 2 plan
 3 implement
 4 sync_pull_request
 5 await_ci
 6 implement
 7 sync_pull_request
 8 await_ci
 9 review
10 mark_pull_request_ready
11 merge_pull_request
```

`kind` says what happened. `ordinal` says where it happened.

Repeated agent work retains an `iteration`, while `reason` explains why:

```text
implement, iteration 2, reason: ci_failure
implement, iteration 3, reason: review_findings
implement, iteration 4, reason: merge_conflict
```

A merge conflict creates another Implement Step in the same Run. Its first
Agent Attempt consumes the next slot from the Run's cumulative 25-Agent-Attempt
budget. After implementation and green CI, the next Review Step consumes the
next slot from the cumulative five-Review-Step budget as well as its Agent
Attempt. A second merge conflict continues from those new totals; neither
counter resets.

That Implement Step resumes the existing implementer Agent Thread rather than
starting a context-free agent. It receives the authoritative merge outcome as
structured input: the pull request, the exact reviewed head SHA, the target
branch and its current head SHA, and the bounded conflict diagnostics available
from GitHub. The shared Run Worker workspace and resumed thread preserve the
implementation context, while the explicit merge handoff tells the implementer
what changed after review.

The new Implement Step begins at Agent Attempt 1 because Agent Attempt numbers
are scoped to one Step. That local numbering is not a budget reset: the Run's
total authorized Agent Attempts remains cumulative. Native activity-retry
counters are likewise scoped to each activity execution and are not semantic
rework budgets.

Rename the current `Stage` concept to `AgentStage`. `plan`, `implement`, and
`review` remain valuable as agent-specific vocabulary used by prompts, models,
paths, and transcripts. They no longer pretend to describe the entire Run.

The Run's current phase is derived from its currently running Step. A separate
mutable phase history is not needed because it would duplicate and potentially
disagree with the Step history.

## Step reasons and handoffs

A Step created in response to an earlier Result must receive that Result as
structured input. Resuming an Agent Thread preserves conversation context, but
it does not tell the agent what an external system discovered after the
previous Step finished.

In particular, red CI creates a new `implement` Step:

```text
Step: implement
  Agent Attempt 1 on implementer Thread A
  Result: changes pushed

Step: await_ci
  Result: ci_red for head SHA H, with failed checks

Step: implement
  reason: ci_failure
  input: the authoritative CI Result for H
  Agent Attempt 1 resumes implementer Thread A
```

The CI-triggered Implement Step must receive the exact checked head SHA and
actionable evidence for every failed check. The evidence must be bounded and
treated as untrusted prompt input. Passing only the preceding implementation
report is insufficient: the implementer authored that report before CI ran.

The current system does not meet this requirement. It retains failed-check
names and opaque fingerprints for workflow progress detection, then discards
the underlying annotations and log evidence after hashing them. The next
implement prompt receives the plan, previous implement report, and latest
review findings, but no CI Result.

Merge conflicts follow the same handoff rule:

```text
Step: merge_pull_request
  input: pull request P at reviewed head SHA H against target head SHA B1
  Result: merge_conflict after the target branch advanced to SHA B2,
          with bounded GitHub conflict diagnostics

Step: implement
  reason: merge_conflict
  input: the authoritative merge Result for P, H, and B2
  Agent Attempt 1 resumes implementer Thread A
```

The implementer reconciles the branch with the current target branch and pushes
the correction. The workflow then runs CI and a fresh reviewer again before it
may make another merge request. This is not a fresh Run and does not reset any
cumulative limit.

## CI waiting

The current `ObserveCI` activity owns a real-clock loop: it queries GitHub,
sleeps for 15 seconds while checks are pending, heartbeats, and repeats until
its own internal bound expires. Move this to the same retry-backed waiting
pattern selected for the dispatcher.

The target `AwaitCI` activity performs one bounded GitHub read for the exact
candidate head SHA per activity try. `RunPolicy` supplies a non-empty explicit
set of required checks; unrelated green checks are retained for diagnostics
but cannot satisfy, mask, or replace a missing required check:

```text
all required checks green -> return the authoritative green CI Result
any required check red    -> return the authoritative red CI Result
required check absent, pending, or superseded
                    -> retryable CINotConcluded
                       with NextRetryDelay = 15 seconds
```

Use a short `StartToClose` timeout for one GitHub request, unlimited attempts,
and a `ScheduleToClose` timeout for the whole CI waiting window. Because each
try is short, no activity heartbeat is needed. If `ScheduleToClose` expires,
the workflow converts that timeout into the explicit `unobserved` CI Result
rather than treating it as red or silently inventing success.

Intermediate pending retries do not add one workflow event per poll and do not
create Steps or Agent Attempts. Real transient GitHub failures use the
activity's technical backoff; authentication and other permanent failures stop
the Step. Because `AwaitCI` is scheduled with the Run's Session context, every
try executes on the same Run Worker and a main-worker deploy cannot replace
the activity implementation midway through the wait.

## Step boundary

This is decided:

> A Step is one independently executed unit of workflow work.

A Step has exactly one primary operation. This normally produces a one-to-one
relationship between a user-meaningful Step and a named Temporal activity, but
it does not mean every Temporal activity is a Step. Temporal may execute that
activity more than once under its native retry policy without creating another
Step or Agent Attempt.

For example, workspace preparation contains independently meaningful retry
boundaries and is recorded as separate Steps:

```text
Phase: Preparing
  Step: create_run_worker
  Step: acquire_run_worker_session
  Step: clone_repository
```

Each can fail independently, has its own timeout and retry behavior, and is
useful to identify precisely in the console. The broader `Preparing` phase is a
display grouping derived from the current Step, not another history stream.

A Step may use supporting activities when they serve the same indivisible goal,
are not independently interesting to an operator, and do not own a separate
retry policy. For example, finding an existing pull request can support a
`sync_pull_request` Step without becoming a separate Step.

Persistence and orchestration plumbing are not Steps. This includes activities
such as `RecordStep`, `RecordAgentAttemptStart`, `RecordAgentAttemptEnd`, and
`RecordRunEnd`. Otherwise recording a Step would recursively require another
recorded Step.

If several operations each need their own retry policy or independently useful
outcome, they are separate Steps. If several low-level operations truly form
one retryable goal, prefer deepening them behind one named, idempotent primary
activity.

## Agent Attempt status and Step Result

This is decided:

> Agent Attempt status says what happened to one workflow-authorized agent
> execution of the Step. Step Result says what the Step's operation
> authoritatively discovered or produced.

A successful activity execution or Agent Attempt does not imply that the
workflow achieved its desired business result. It means the Step's primary
operation completed and returned an authoritative answer.

For example:

| Step | Execution status | Step Result | Workflow decision |
| --- | --- | --- | --- |
| `await_ci` | `succeeded` | `ci_green` | Continue to review. |
| `await_ci` | `succeeded` | `ci_red` | Create another `implement` Step. |
| `merge_pull_request` | `succeeded` | `merged` | End domain work successfully; perform only durable recording and cleanup. |
| `merge_pull_request` | `succeeded` | `merge_conflict` | Create another `implement` Step. |
| `implement` | Agent Attempt `succeeded` | `blocked` | End the Run without starting another Agent Attempt. |
| Any primary operation | Activity retries exhausted | none | Fail the Step. |

A timeout, worker crash, or transport failure may cause Temporal to retry the
same activity. That retry is infrastructure recovery, not an Agent Attempt. A
red CI result or merge conflict is a completed domain Result; responding to it
creates a different Step or ends the Run.

An agent-backed Step may explicitly start another Agent Attempt when the prior
execution failed and cannot be recovered. That is a workflow decision above
Temporal's activity retry mechanism. Every retry of the activity for that
Agent Attempt must carry the same Agent Attempt identity and reconcile or
resume it; it must never silently authorize another execution.

A Step is `running` while its activity, native retry wait, or Agent Attempt is
active. It becomes `completed` when its operation returns a domain Result,
including results such as `ci_red`, `merge_conflict`, or `blocked`. It becomes
`failed` when native activity retries are exhausted, a non-retryable execution
error occurs, or an agent-backed Step cannot start another permitted Agent
Attempt.

The persisted terminal vocabulary is closed and deliberately coarser than a
raw error string:

| Record | Values |
| --- | --- |
| Run outcome | `succeeded`, `canceled`, `exhausted`, `failed` |
| Run failure kind | `invalid_input`, `agent_unrecoverable`, `agent_attempt_budget`, `review_budget`, `ci_unobserved`, `github_auth`, `github_ruleset`, `github_unavailable`, `run_worker_unavailable`, `persistence_unavailable`, `infrastructure` |
| Step state | `running`, `completed`, `failed` |
| Agent Attempt state | `running`, `succeeded`, `failed` |
| Usage state | `unknown`, `measured` |

Step Result is kind-specific structured data rather than one global enum. For
example, `await_ci` may store `ci_green`, `ci_red`, or `ci_unobserved`, while
`merge_pull_request` may store `merged`, `merge_conflict`, `head_changed`,
`base_refresh_required`, or `closed_unmerged`. Raw bounded diagnostics remain
attached to the Result or failure record without becoming control vocabulary.

This keeps three questions separate:

```text
Agent Attempt = did this authorized agent execution complete?
Step Result   = what did the operation discover or produce?
Workflow      = what Step should happen next?
```

## Temporal activity names

Do not introduce a generic Temporal activity such as `ExecuteStep`.

Keep dedicated activities:

```go
acts.PrepareWorkspace
acts.RunPlan
acts.RunImplement
acts.SyncPullRequest
acts.AwaitCI
acts.RunReview
acts.MarkPullRequestReady
acts.MergePullRequest
```

A private workflow helper can wrap those activities with Step recording:

```go
out, err := runStep(
    ctx,
    StepSpec{
        Kind:   work.StepAwaitCI,
        Policy: policies.AwaitCI,
    },
    acts.AwaitCI,
    input,
)
```

Because the actual method reference remains `acts.AwaitCI`, Temporal continues
to show the meaningful `AwaitCI` activity name. The helper provides only the
standard lifecycle around it:

```text
begin Step
  execute named activity with native Temporal retries
finish Step
```

For agent activities, `runAgentStep` can be a thin layer over the same primitive
that explicitly creates Agent Attempts and adds model, usage, transcript, and
thread information. Every native activity retry for one Agent Attempt receives
the same durable Agent Attempt ID. It is not a second Step system.

A user-meaningful Step has one primary named activity. Where the workflow
currently uses multiple low-level activities for one action, for example
`FindPullRequest` followed by `OpenOrUpdatePullRequest`, deepen that operation
into one idempotent `SyncPullRequest` activity when practical. Both Temporal and
the console then show a useful name without exposing implementation chatter.

Database-recording activities are deliberately not Steps. Otherwise recording
a Step would require recording the recording Step recursively.

## Run Worker GitHub credential lifetime

This work must also remove the current one-hour GitHub credential failure
mode.

The worker currently mints one repository-scoped GitHub App installation
token while cloning the repository, then writes that token into both the
sandbox's Git credential store and `gh` configuration. GitHub caps the token's
lifetime at approximately one hour, but the Run Worker and Run can live much
longer. Nothing replaces either credential file during the Run. A later agent
execution can therefore receive an otherwise healthy Run Worker whose GitHub
credential has expired. In particular, `git push` then fails inside `codex
exec`, where the workflow sees only the agent's resulting tool failure rather
than a classifiable GitHub activity error.

This is distinct from the Codex OAuth credential. The worker already owns the
rotation and Run Worker handoff protocol for that credential. "GitHub token"
must not be used as an ambiguous name for both mechanisms.

The target invariant is:

> Every agent execution that may use Git or `gh` starts with a newly minted
> Run Worker GitHub credential and remains supplied with a valid credential for
> the entire authorized execution.

Minting remains main-worker-owned because the GitHub App private key must not
enter the Run Worker. A main-control activity mints the token and atomically
updates the Run Worker's per-generation Kubernetes Secret. The pod mounts the
Secret as a directory, never with `subPath`, so kubelet projects later Secret
revisions without exec or file transfer. The activity returns only a non-secret
revision and expiry, never the token. A small Run Worker activity waits until
that revision is visible before agent execution begins. This credential
handoff is supporting machinery, not a user-meaningful Step.

The renewal lifecycle is scoped to every Agent Attempt. A worker-side
supporting activity mints and installs the credential immediately before the
Run Worker agent activity starts. While that Agent Attempt remains active,
the workflow runs the agent activity and a credential-renewal loop
concurrently. The loop mints and installs another credential every 30 minutes
and stops when the Agent Attempt finishes.

The agent receives a replacement without restarting. Git uses a credential
helper that reads the current projected token file for every remote operation.
The Run Worker places a `gh` launcher earlier on `PATH`; each invocation reads
the same current token file into that child process and then execs the real
binary. No long-lived Codex environment variable contains a token. Kubernetes
owns atomic projection of the Secret directory. A command already using the
previous token may finish with it; renewal at 30 minutes leaves overlap before
the previous token's expiry.

The renewal activity must combine minting and installation so the token never
appears in Temporal workflow input, output, or history. It may return
non-secret expiry metadata. Native retries of the agent activity do not create
another renewal loop; the same loop remains active for the whole Agent Attempt.
If a scheduled renewal exhausts its own native activity retries, the workflow
cancels and fails the Agent Attempt rather than allowing it to continue toward
an unauthenticated Git operation.

Each agent activity try has a 55-minute `StartToClose` timeout. The whole Agent
Attempt has a 90-minute `ScheduleToClose` timeout across queueing, execution,
retry backoff, and all native activity tries. This gives a provider outage time
to recover without multiplying the worst case into ten independent 55-minute
windows. These are operational bounds on stuck or expensive work, not
authentication limitations. The periodic credential loop remains active for
the whole Agent Attempt and renews at minutes 30 and 60 when necessary.

## Retry and Agent Attempt policy

There are two deliberately separate policies:

1. **Activity retry policy** handles transient execution failures using
   Temporal's native retries. This applies to infrastructure and agent
   activities. It does not create Agent Attempts.
2. **Agent Attempt policy** decides whether an agent-backed Step may abandon an
   unrecoverable execution and authorize another one. This is explicit workflow
   logic and creates another Agent Attempt row.

An activity retry of agent work must be idempotent around its Agent Attempt ID.
Before Codex starts, the main worker durably creates the Step and Attempt. As
soon as Codex yields a provider thread identity, and again when it reaches a
terminal result, the trusted Run Worker activity writes a checkpoint through a
narrow per-Run API capability. The API persists thread identity, terminal
envelope, usage state, and transcript before the activity acknowledges
success. A retry or replacement first reads that record and otherwise resumes
the execution's thread where possible. Only the workflow may allocate a new
Agent Attempt ID and authorize another potentially chargeable execution. The
per-Run capability is minted inside provisioning, stored hashed with Run
ownership, mounted from a Secret, and cannot finalize a Ticket or mutate
another Run.

Repository-affine effects have a separate durable Git/PR checkpoint. After a
successful push or pull-request synchronization, the Run Worker atomically
records the branch, pushed head SHA, observed base SHA, PR number and node ID,
and the completed Step Result before the activity acknowledges success. A
retry or replacement reconciles GitHub with that checkpoint first. Therefore a
worker that dies after GitHub accepts the write but before Temporal receives
the response neither repeats the effect blindly nor regresses to an older
head.

Postgres does not store one row per native activity try. Temporal owns that
low-level operational history. Postgres remains authoritative for the Step's
state and Result and for every Agent Attempt. The console therefore does not
need Temporal to determine product state, but it may link to Temporal for
activity-retry diagnostics. A retry count or latest transient failure may be
copied onto the Step later as a convenience summary without making activity
tries domain entities.

Recording writes themselves can keep automatic Temporal retries. They are
persistence plumbing, not Ticket work. They should become mandatory: currently
Step and Agent Attempt writes are logged and ignored after exhausting retries,
despite the system's stated goal that the console is authoritative.

Critical recording activities use finite per-try timeouts and no attempt cap.
They retry for the remaining workflow lifetime with capped backoff. A temporary
Postgres outage pauses orchestration at the persistence boundary; it does not
skip the record, start another Step, or turn into a fresh Run.

The workflow must not start an externally effective operation until its Step
and, when applicable, Agent Attempt start are durable. It must not make the
next domain decision until the preceding Result is durable. After a confirmed
merge, one idempotent database transaction records the merge Step Result and
merge SHA, marks the Run successful, marks the Ticket `done`, and satisfies its
dependency edges. Temporal retries that transaction until it commits or the
workflow's reserved finalization window is exhausted; it never requests the
merge again merely because the recording activity retried.

The Run's semantic-work deadline and its hard workflow timeout must therefore
be different. New Steps stop before the semantic-work deadline. A separate
finalization buffer remains available for mandatory recording after the last
domain Result. The exact buffer is still a policy decision. If the system later
permits the hard timeout to expire after GitHub has confirmed a merge, it will
also need a reconciler that can finish the idempotent database transaction from
the authoritative GitHub state; it must never reopen the merged Ticket as new
work.

Run Worker teardown has a different durability requirement. After the merged
Run is finalized, `WorkOnTicket` completes its Session and asks the main worker
to delete the Run Worker and its temporary resources with bounded retries. If
those retries are exhausted, an orphan sweeper owns the deletion. Teardown is
not a Step, does not delay the Ticket's `done` transition, and cannot reverse
the successful Run.

The initial activity-retry direction is:

| Work | Initial policy |
| --- | --- |
| Agent activity | Retry transient machinery failures, but never turn a retry into a fresh agent run. |
| Infrastructure reads | Several transient retries. |
| Idempotent infrastructure writes | Several transient retries, reconciling existing state first. |
| Invalid, permanent, or authentication failures | Never retry within the Step. |
| Rate limiting | Stop the Run and let the dispatcher cooldown policy handle it. |
| Merge | Reconcile after ambiguous failure; conflicts and head changes are domain outcomes, not retryable transport errors. |
| Recording writes | Retry without an attempt cap inside the workflow lifetime; never cross an unrecorded domain boundary. |
| Run Worker teardown | Retry for a bounded interval, then transfer responsibility to the orphan sweeper without reversing the Ticket outcome. |

Agent activities use at most ten native activity tries in one Agent Attempt:
the initial try plus nine retries. The retry interval starts at 10 seconds,
doubles after each failure, and is capped at 5 minutes. If failures occur
immediately, the approximate try start times are:

```text
00:00  00:10  00:30  01:10  02:30
05:10  10:10  15:10  20:10  25:10
```

This gives a provider or selected model that remains unavailable for around
ten minutes time to recover without rapidly consuming the retry budget. Each
try has up to 55 minutes from `StartToClose`, while the Agent Attempt's
90-minute `ScheduleToClose` timeout bounds queueing, execution, backoff, and
all ten tries together. If failures happen quickly enough to consume the full
backoff schedule, a final successful try can still receive its full 55-minute
execution window without allowing the Attempt to run indefinitely.

Provider or model unavailability is retryable within this policy. Explicit
authentication failures are permanent for the Agent Attempt, and provider
rate limits end the Run through the dispatcher cooldown path rather than
spending ten retries. Every retry reconciles or resumes the same Agent Attempt
and Agent Thread; it must not silently begin another potentially chargeable
agent execution.

Agent activities use a five-minute progress heartbeat timeout. Codex activity
events record heartbeats; there is deliberately no separate periodic
process-liveness heartbeat. Five minutes without a progress event means the
current activity try is considered stalled and enters the native retry policy.
The elapsed execution and retry backoff still count toward the Agent Attempt's
90-minute `ScheduleToClose` limit.

The Run has one deliberately simple agent-execution budget:

> A Run may authorize at most 25 Agent Attempts in total.

Plan, Implement, and Review Agent Attempts all consume the same budget. The
workflow allocates an Agent Attempt before scheduling its execution, so an
ambiguous timeout still consumes that Attempt even when the system cannot
prove how much work ran. The workflow must end the Run as exhausted rather
than authorize Agent Attempt 26.

There is no separate possibly-chargeable-execution budget. An activity retry
that reconciles or resumes the same authorized execution remains part of the
same Agent Attempt and does not consume another slot.

These remain different concepts:

- An **activity retry** is Temporal repeating the same operation after a
  transient execution failure.
- An **Agent Attempt** is one workflow-authorized execution of one agent-backed
  Step, potentially spanning technical retries and resumes.
- A new agent-backed **Step** starts at Agent Attempt 1 even if it resumes a
  Codex thread from an earlier Step.
- A later Agent Attempt of the same Step is created only when the previous one
  cannot be recovered and the workflow deliberately authorizes another.
- A new `implement` Step after red CI is semantic rework.
- A new `implement` Step after review findings is semantic rework.
- The existing implement and review turn ceilings are progress budgets, not
  retry counts.

## Review-cycle budget

This is decided:

> A Run may execute at most five Review Steps.

Each completed Review Step consumes one of the five review cycles whether it
returns no findings or requests another Implement Step. Activity retries of
that Review Step do not consume another cycle, and Agent Attempts within that
Step do not consume another review cycle. CI-red Implement Steps that occur
before the next Review Step are governed by the separate implementation and
total Agent Attempt budgets.

## Existing assumptions that must change

This reaches further than a database migration:

- `Step` is currently an alias for agent-only `StageKey`.
- The current Attempt table already represents agent execution details, but its
  name and surrounding model imply that every Step has Attempts.
- Agent Attempt number is always hard-coded to `1`.
- Step and Attempt recording is currently best-effort.
- Usage rollups already operate on agent execution records and should remain
  agent-specific.
- Transcript identity and API routes are based on `stage/turn`.
- Metrics are agent-stage-specific. They should remain so, with separate
  generic Step metrics if they become useful.
- `RunPolicy` conflates limits on fresh agent runs with native activity retry
  limits through `StageAttempts` and `ControlAttempts`.
- The 24-hour Run budget is calculated from the maximum number of agent
  invocations only. Recalculate it against the v0 merge-terminal workflow; it
  must not reserve time for deployment observation.

## Existing workflow histories and cutover

Do not use `workflow.GetVersion` to migrate workflows started before this
redesign. Instead, deployment is gated by a one-time cutover runbook:

1. pause the old dispatcher and prove it admits no new Tickets;
2. inventory every open old dispatcher/Ticket execution and factory PR;
3. disable GitHub auto-merge on every unmerged factory PR so an old Run cannot
   merge after ownership moves;
4. cancel cooperative Runs, terminate any remainder, and terminate the old
   dispatcher;
5. transactionally return all old `working` and `review` Tickets to `open`
   without marking those Runs successful; and
6. prove there are no open pre-redesign workflows before deploying the new
   command sequence.

Postgres history is preserved separately. Additive releases use a dual-read
compatibility projection because legacy workflows may create `(stage, turn)`
rows after the first target schema migration. Only after the cutover inventory
is empty does an idempotent final backfill copy every remaining legacy Step,
Attempt, and transcript into the ordinal model, verify counts and ordering, and
switch reads to the target projection. Excluding Temporal history migration
does not authorize deleting the console's durable history.
After cutover, every new Run still receives an immutable Run Policy snapshot in
its workflow arguments.

## Run policy snapshot

`RunPolicy` remains part of the workflow arguments. That is intentional: the
arguments durably record the exact limits, timeouts, and retry behavior that a
Run began with. A deploy may change the defaults used to construct future
inputs without silently changing an existing Run during replay.

The shape of `RunPolicy` must change. Remove the generic `StageAttempts` and
`ControlAttempts` fields, which currently apply one number to unrelated work.
Replace them with explicit sections for the domain budgets and named technical
activity policies. For example, the agent-execution policy owns its two
timeouts, heartbeat, retry count, and backoff; credential renewal and durable
recording each own their separate retry policy. These are resolved values in
the workflow input, not mutable configuration read during workflow execution.
The policy also contains the exact non-empty required-check set used by
`AwaitCI`; a Run with no required checks is invalid rather than implicitly
green.

## Publishing policy to the dispatcher

The factory dispatcher is a long-lived singleton workflow. Today the worker
constructs `DefaultRunPolicy()` when it ensures that dispatcher exists, the
dispatcher stores the policy in its own workflow input, and every child Run
receives that policy in `WorkOnTicketInput`. Starting new workers therefore
does not update an already-running dispatcher, including after the dispatcher
continues as new.

The target is an acknowledged startup handshake without a first-worker
deadlock. The process has two Temporal workers: a small control worker polling
a dedicated dispatcher task queue, and the ordinary main worker polling Run
workflow and main-activity queues.

1. Resolve the complete `RunPolicy` in the worker process.
2. Start the control worker, which registers only the dispatcher workflow.
3. Publish it with Temporal Update-With-Start using the dispatcher's stable
   workflow ID and `WorkflowIDConflictPolicy_USE_EXISTING`.
4. Set Temporal's Update ID to this publication's stable `request_id`, so a
   retry after a lost response is the same protocol operation rather than a
   merely similar payload.
5. Wait for the Update to be accepted and completed.
6. Only then start the main worker and allow Run work or activities to poll.

This makes publication a startup gate rather than a best-effort background
signal. A malformed policy is rejected by the Update validator. The caller
receives an explicit answer, and rejected Updates do not add events to workflow
history.

The simplest Update payload under discussion has this shape:

```text
RunPolicyUpdate
  request_id
  policy_fingerprint
  git_sha
  policy
```

`policy_fingerprint` is a stable hash of the complete resolved policy and lets
the handler return `ALREADY_CURRENT`. It is not the Temporal Update ID: a
policy may intentionally move A to B and later back to A. Git SHA is retained
only as audit metadata; it does not order publications and it does not decide
whether two policies are equal. `request_id` identifies one worker publication
call, is the Temporal Update ID, and remains stable when that caller retries an
ambiguous transport failure.

The dispatcher applies non-duplicate Updates in the order Temporal delivers
them. The latest accepted policy therefore wins. There is no separate policy
revision or deployment-order comparison.

The three worker-startup outcomes are:

```text
APPLIED          -> this Update changed the current policy; start polling
ALREADY_CURRENT  -> an identical policy is already current; start polling
FAILED           -> publication or validation genuinely failed; do not poll
```

`ALREADY_CURRENT` must be distinguishable from genuine failure because it is a
successful startup condition. Prefer returning it as a typed validator
rejection so an unchanged publication does not add an accepted Update to
workflow history. The worker recognizes only that specific typed rejection as
success. Invalid policy, Temporal unavailability, timeout without a conclusive
retry, or any other error keeps the worker out of the task queue and should
fail startup.

The handler must be synchronous and contain no await points, or otherwise use
workflow-safe serialization, so two policy writes cannot interleave. The
dispatcher carries the current policy and fingerprint when it continues as
new.

The alternatives considered were:

- A Signal is insufficient because publication needs validation and an
  acknowledged result before the worker begins polling.
- Git SHA is the wrong deduplication identity because runtime-resolved policy
  can change independently of code, while two different builds may resolve to
  exactly the same policy.
- A Rollout ID or numeric policy revision is unnecessary for last-arrival-wins
  semantics.

## Dispatcher waiting model

The current dispatcher owns a workflow-level polling loop. Each tick drains
signals and child completions, reconciles in-flight work, sweeps orphaned Run
Workers, queries for ready Tickets, starts children, and sleeps on a Temporal
timer. A ten-second idle poll therefore grows workflow history forever and
forces `ContinueAsNew` based primarily on the passage of time.

Replace the ready-Ticket portion with a long-lived polling activity whose retry
state represents expected waiting:

```text
AwaitDispatchableTickets
  tickets found -> return a non-empty batch
  no tickets    -> return retryable NoDispatchableTickets
                   with NextRetryDelay = 10 seconds
```

Temporal does not add each intermediate activity retry to workflow event
history. The activity should have a short `StartToClose` timeout for each
database query, unlimited attempts, and no `ScheduleToClose` timeout because an
idle dispatcher is allowed to wait indefinitely. `NextRetryDelay` controls the
normal ten-second no-work cadence. Genuine transient database failures use a
separate exponential infrastructure-retry delay, while malformed input and
other permanent failures stop the activity.

`NoDispatchableTickets` is an expected waiting condition. It must not be
reported as an operational error in alerts, logs, metrics, or the console. The
retries are Temporal orchestration machinery, not Ticket Steps, Agent Attempts,
or Postgres history rows.

The dispatcher workflow should select over the wait-activity Future, accepted
policy Updates, and child-workflow completions. It should not schedule the wait
activity while paused or already at concurrency capacity, and it should cancel
an outstanding wait when a state change makes it unnecessary.

This eliminates idle-time history growth, but it does not make the dispatcher
literally history-free. Accepted policy Updates and actual child starts and
completions still create history. Retain `ContinueAsNew` as a safety mechanism,
but let Temporal decide when it is becoming appropriate through
`workflow.GetInfo(ctx).GetContinueAsNewSuggested()`. Do not maintain an
application-owned event-count threshold.

When Temporal suggests continuing as new, the dispatcher enters a draining
mode instead of immediately rolling over:

```text
dispatching
  -> Temporal suggests ContinueAsNew
  -> draining: stop claiming or starting new Tickets
  -> wait for every already-started Ticket workflow to finish
  -> drain its completion handling until in-flight is empty
  -> ContinueAsNew with the current resolved policy
  -> dispatching in the new execution
```

The dispatcher does not schedule `AwaitDispatchableTickets` while draining and
cancels an outstanding wait activity when it enters that mode. It continues to
process child completions, any required reconciliation, and acknowledged policy
Updates. The latest accepted resolved policy is carried into the new execution.
No child Future or in-flight Run state crosses the boundary because rollover
only occurs from the clean, empty state. Temporal's suggestion is intentionally
conservative, leaving history headroom for the finite drain rather than forcing
the application to guess at a value such as 10,000 events. The temporary pause
in new dispatch is an accepted tradeoff for a much simpler rollover protocol.

Draining also removes the reason the current dispatcher gives Ticket children
`PARENT_CLOSE_POLICY_ABANDON`: children no longer need to outlive a parent that
continues as new. Set their parent-close policy explicitly to
`PARENT_CLOSE_POLICY_REQUEST_CANCEL`, not the default `TERMINATE`. Consequently,
canceling, terminating, failing, or timing out the dispatcher requests
cancellation of every live `WorkOnTicket` child, while an ordinary worker
process restart closes neither workflow and Temporal resumes both normally.
Pausing or draining is the control for stopping new dispatch while allowing
existing Runs to continue; canceling the dispatcher means canceling the whole
owned tree.

`WorkOnTicket` must treat requested cancellation as a durable outcome. From a
disconnected workflow context, it atomically records the Run as canceled and
returns the Ticket from `active` to `open` if that Run still owns the active
Ticket. It then performs bounded Run Worker teardown, with the orphan sweeper as
fallback, before returning the cancellation error. The conditional ownership
check prevents a late cancellation from reopening a Ticket whose confirmed
merge was already committed as `done`. This replaces the current behavior that
cleans up but strands a canceled Ticket in `active`.

The existing tick also bundles work that is not ready-Ticket polling and must
be deliberately relocated:

- Observe child-workflow Futures as the authoritative completion mechanism.
  Remove the custom completion signal and periodic `DescribeRun`
  reconciliation; Temporal reconstructs Futures on replay, and draining means
  no live Future crosses `ContinueAsNew`.
- Run `MaintainFactory` from a Temporal Schedule rather than waking the
  dispatcher for maintenance. It reconciles closed Ticket Runs that still own
  `active` Tickets and Run Workers whose Runs are no longer live, using Store
  ownership checks before reopening a Ticket.
- Receive policy publication through the acknowledged Update handler described
  above.

## Current design direction

1. Generalize Step around `kind + ordinal`.
2. Rename the existing Stage concept to AgentStage.
3. Give only agent-backed Steps Agent Attempts.
4. Scope Agent Attempt identity to one Step, independently of Codex thread
   identity.
5. Keep concrete, well-named Temporal activities.
6. Keep transient execution retries in Temporal's native activity retry policy.
7. Keep semantic-rework budgets separate from infrastructure retry policy.
8. Give every Step exactly one primary operation.
9. Keep Agent Attempt status separate from the Step's domain Result.
10. Keep native activity-try history in Temporal rather than duplicating it in
    Postgres.
11. Renew the Run Worker GitHub credential during a Run before agent execution;
    continue renewing it every 30 minutes during the Agent Attempt, and never
    rely on the credential minted during the initial clone remaining valid.
12. Permit at most five Review Steps in one Run.
13. Permit at most 25 Agent Attempts across all agent-backed Steps in one Run.
14. Bound each agent activity try to 55 minutes from `StartToClose` and the
    whole Agent Attempt to 90 minutes from `ScheduleToClose`.
15. Give agent activities ten total native tries with 10-second exponential
    backoff, coefficient 2, and a 5-minute maximum interval.
16. Keep agent heartbeats tied to progress events, with a 5-minute heartbeat
    timeout and no independent process-liveness heartbeat.
17. Keep a resolved, immutable `RunPolicy` snapshot in the workflow arguments,
    while replacing generic `StageAttempts` and `ControlAttempts` fields with
    explicit domain budgets, a non-empty required-check set, and named
    technical retry policies.
18. Publish the worker's current policy to the singleton dispatcher with an
    acknowledged Update-With-Start, deduplicate the resolved policy by a stable
    content fingerprint, and make `APPLIED` or `ALREADY_CURRENT` a
    worker-startup gate before task-queue polling.
19. Wait for dispatchable Tickets through an activity whose expected no-work
    result uses Temporal activity retry with a ten-second `NextRetryDelay`.
20. Remove workflow-timer-driven idle polling from the dispatcher and separate
    child completion observation and orphan cleanup from ready-Ticket polling.
21. Rename the Ticket workflow to `WorkOnTicket` and the per-Run execution pod
    to Run Worker; retire Sandbox as target vocabulary.
22. Create one Run Worker after claiming the Ticket, then immediately use
    `CreateSession` on its private task queue instead of separately polling
    Kubernetes readiness.
23. Execute every filesystem- and repository-affine activity from clone
    through merge with a context derived from the Session. Keep claim,
    recording, credential-Secret rotation, terminal/cancellation finalization,
    provisioning, and cleanup on the main worker so Session loss cannot remove
    recovery.
24. Remove Kubernetes `pods/exec` and remote file transfer from target Run
    execution, but retain the legacy machinery until the final quiesced
    activation; target commands and files remain local to the Run Worker.
25. Give every agent stage the same writable execution environment, while
    retaining role-specific behavioral instructions in prompts.
26. Replace `ObserveCI`'s internal sleep loop with `AwaitCI`: one short GitHub
    read per activity try, a 15-second `NextRetryDelay`, and a
    `ScheduleToClose` bound for the complete wait.
27. Keep optional human approval out of this version; successful Runs are
    fully unattended.
28. Request squash merges only, and keep merge-conflict recovery inside the
    same Run without resetting the five-Review-Step or 25-Agent-Attempt
    cumulative budgets.
29. Make a confirmed merge the v0 terminal business outcome: persist the merge
    SHA, mark the Run and Ticket successful after durable recording, satisfy
    dependency edges, and perform only cleanup afterward. Do not wait for or
    infer deployment state inside `WorkOnTicket`.
30. Make critical database recording a mandatory, idempotent persistence
    boundary with no activity-attempt cap. Reserve finalization time after
    semantic work ends; after the terminal transaction commits, bounded Run
    Worker teardown may fall back to an orphan sweeper without changing the
    Ticket outcome.
31. When Temporal suggests `ContinueAsNew`, put the dispatcher into draining
    mode: start no new Tickets, await all in-flight child Futures, then
    roll over carrying only the latest resolved policy. Do not use a custom
    event-count threshold or serialize live child state into the new execution.
32. Replace the dispatcher's child `ABANDON` policy with explicit
    `REQUEST_CANCEL`. Dispatcher cancellation owns the whole child tree;
    canceled Runs are durably recorded, their still-owned Tickets return from
    `active` to `open`, and Run Worker teardown retains its sweeper fallback.
33. Use Temporal child Futures as the dispatcher's sole normal completion
    mechanism; remove custom completion signals and `DescribeRun`
    reconciliation.
34. Recover permanent Session loss inside the same Run by creating one
    replacement Run Worker at a time from the same pinned image and resuming
    after the latest durable Step boundary without resetting budgets.
35. Checkpoint branch, pushed head, observed base, PR identity, and the
    completed repository-affine Step Result before acknowledging Git/PR
    effects; reconcile that checkpoint before repeating an ambiguous write.
36. Treat GitHub permission and ruleset rejection as repairable infrastructure:
    retry with bounded backoff until the Run deadline, then use the existing
    `failed` Ticket state and preserve the specific Run failure kind.
37. Give a post-cancellation Run a fresh branch and pull request, carry useful
    prior commits forward, and ensure the superseded unmerged pull request is
    no longer merge-authorized.
38. Use the existing `failed` Ticket state for infrastructure that cannot
    recover before its Run deadline, while preserving the specific
    infrastructure failure kind on the Run rather than adding another coarse
    Ticket state.
39. Rename the coarse Ticket state `working` to `active`; detailed progress is
    expressed by the current Step rather than another coarse Ticket state.
40. Derive current phase from the persisted Step lifecycle instead of storing
    a duplicate mutable `run.phase` projection.
41. Run a dedicated `MaintainFactory` workflow from a Temporal Schedule to
    reconcile both abandoned Ticket ownership and orphaned Run Workers after a
    Ticket workflow is directly terminated; do not use passive lease expiry.
42. Give every active Ticket an explicit owning Run ID. Claim and Run creation
    are atomic; success, cancellation, manual retry, and maintenance all
    predicate on that owner.
43. Bootstrap policy publication through a separate dispatcher control queue,
    using the publication request ID as Temporal's Update ID before the main
    worker begins polling.
44. Deliver renewable GitHub credentials through an updateable projected
    Secret directory and per-command Git/`gh` readers; do not use pod exec,
    remote copying, a long-lived token environment variable, or the App key in
    the Run Worker.
45. Persist an Agent Attempt's provider identity, terminal result, usage state,
    and transcript through a narrow per-Run API capability before acknowledging
    activity success, so retries and replacement workers can reconcile it.
46. Perform an explicit quiesce/reconcile cutover before deploying the new
    command sequence, while preserving historical Postgres Run data.

## Parked questions

### Future release reconciliation, outside v0

Deployment observation is explicitly outside `WorkOnTicket` v0. A confirmed
merge is enough to mark the Ticket `done` and satisfy its dependencies. The Run
does not poll GitHub Actions for hours or remain active until production
recovers.

A later version may introduce a separate long-lived release-reconciliation
workflow outside any individual Ticket Run. That workflow could continuously
observe the repository's production pipelines, determine whether merged work
is progressing through required deployment targets, and create new repair
Tickets when a release is stuck or failed. It would own release health across
many merged Tickets rather than extending one Run's lifetime or retroactively
changing a done Ticket.

The candidate future release outcomes remain:

- `deployed`: every production target selected for a release completed
  successfully;
- `deployment_not_required`: the canonical change classifier selected no
  production target, rather than a deployment being skipped by failure;
- `failed`: a required build, test, or selected production deployment failed;
- `unobserved`: no authoritative terminal release outcome was available.

If that version is designed, it must define a cumulative release boundary so a
newer `main` run that replaces an older pending run cannot strand the older
commit's build or deployment work. The proposed terminal release verdict and
polling protocol are notes for that future design, not v0 requirements. No
automated revert, rollback, or fix-forward policy is part of v0.

### Retry-policy values

The Agent Attempt timeouts, heartbeat, and agent-activity retry policy are fixed above.
Exact retry counts, backoff, and timeouts for infrastructure activities remain
undecided. They should be chosen from concrete failure scenarios rather than
inheriting the current five-control-attempt default wholesale.

### Dispatcher decomposition

The retry-driven wait and acknowledged policy publication are the direction.
The following code-level policy still needs verification:

- The per-query timeout and retry policy for real dispatcher database errors,
  independently of the ten-second expected no-work delay.

### Run Worker capabilities and failure

The ownership, credential delivery, recording, and routing model is settled.
Fresh-filesystem provider resume is an explicit pre-implementation capability
gate, not a settled Codex capability. Before building the Run Worker, a
black-box test against the exact target Codex CLI must capture thread identity,
kill execution at controlled points, and resume from a new process on a fresh
filesystem. If it cannot do that, A02/I08 and the Attempt recovery behavior
must be revised explicitly before PR 4; implementation must not silently rely
on local files surviving or substitute another execution model.

These remaining implementation details still need a security and failure-mode
pass:

- The exact per-Run API-capability representation and revocation path. It may
  checkpoint only its own Agent Attempt and transcript; it cannot finalize a
  Ticket or mutate another Run.
- The exact provider metadata and lifecycle semantics proven by the capability
  gate. The safe fallback remains a failed incomplete Attempt followed by a
  newly authorized Attempt within the existing budget, not rerunning completed
  Steps.
- Which additional tools, including a future Temporal CLI, belong in the Run
  Worker image and what authority the agent receives when invoking them.
