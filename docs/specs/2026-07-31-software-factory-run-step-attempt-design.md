# Software factory Run, Step, and Agent Attempt design

Status: **working design**

This document records the software factory lifecycle design discussion as of
2026-07-31. It is intentionally not yet an ADR. The remaining questions, most
notably where `merged` and `deployed` sit in the lifecycle, can still change the
completion boundary and the Run timeout.

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

## Established surrounding direction

The current direction for the merge flow is:

1. Run the existing implement, CI, and internal-review loop.
2. After a clean review, mark the pull request ready.
3. Explicitly call GitHub's merge API with the reviewed head SHA.
4. Treat only an HTTP success response with `merged: true` and a returned merge
   SHA as a confirmed merge.
5. Re-read the pull request after an ambiguous response so a lost response does
   not cause the workflow to guess.
6. If the head changed, rerun CI and internal review for the new head.
7. If GitHub reports a textual conflict, return to implementation, merge the
   latest `main` into the branch, resolve the conflict, rerun CI and review, and
   attempt the merge again.

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

`review` is removed because there is no longer a human waiting state. Whether
`done` means merged or deployed is deliberately unresolved below.

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
Step: prepare_workspace
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
 5 observe_ci
 6 implement
 7 sync_pull_request
 8 observe_ci
 9 review
10 mark_pull_request_ready
11 merge_pull_request
12 cleanup_workspace
```

`kind` says what happened. `ordinal` says where it happened.

Repeated agent work retains an `iteration`, while `reason` explains why:

```text
implement, iteration 2, reason: ci_failure
implement, iteration 3, reason: review_findings
implement, iteration 4, reason: merge_conflict
```

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

Step: observe_ci
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
  Step: create_sandbox
  Step: wait_for_sandbox_ready
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
| `observe_ci` | `succeeded` | `ci_green` | Continue to review. |
| `observe_ci` | `succeeded` | `ci_red` | Create another `implement` Step. |
| `merge_pull_request` | `succeeded` | `merged` | Continue past the merge boundary. |
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
acts.ObserveCI
acts.RunReview
acts.MarkPullRequestReady
acts.MergePullRequest
acts.DeleteWorkspace
```

A private workflow helper can wrap those activities with Step recording:

```go
out, err := runStep(
    ctx,
    StepSpec{
        Kind:   work.StepObserveCI,
        Policy: policies.ObserveCI,
    },
    acts.ObserveCI,
    input,
)
```

Because the actual method reference remains `acts.ObserveCI`, Temporal continues
to show the meaningful `ObserveCI` activity name. The helper provides only the
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

## Sandbox GitHub credential lifetime

This work must also remove the current one-hour GitHub credential failure
mode.

The worker currently mints one repository-scoped GitHub App installation
token while cloning the repository, then writes that token into both the
sandbox's Git credential store and `gh` configuration. GitHub caps the token's
lifetime at approximately one hour, but the sandbox and Run can live much
longer. Nothing replaces either credential file during the Run. A later agent
execution can therefore receive an otherwise healthy sandbox whose GitHub
credential has expired. In particular, `git push` then fails inside `codex
exec`, where the workflow sees only the agent's resulting tool failure rather
than a classifiable GitHub activity error.

This is distinct from the Codex OAuth credential. The worker already owns the
rotation and sandbox handoff protocol for that credential. "GitHub token"
must not be used as an ambiguous name for both mechanisms.

The target invariant is:

> Every agent execution that may use Git or `gh` starts with a newly minted
> sandbox GitHub credential and remains supplied with a valid credential for
> the entire authorized execution.

Minting remains worker-owned because the GitHub App private key must not enter
the sandbox. The new token must be written into both sandbox credential files
without putting the token in Temporal workflow input, output, or history. This
credential handoff supports an agent-backed Step; it is not itself a
user-meaningful Step.

The renewal lifecycle is scoped to every Agent Attempt. A worker-side
supporting activity mints and installs the credential immediately before the
sandbox-side agent activity starts. While that Agent Attempt remains active,
the workflow runs the agent activity and a credential-renewal loop
concurrently. The loop mints and installs another credential every 30 minutes
and stops when the Agent Attempt finishes.

The agent receives a replacement without restarting. Git's configured
credential helper reads its credential file for each remote operation, and
each new `gh` process reads `hosts.yml` through `GH_CONFIG_DIR`. Each file must
be written to a sibling temporary file with mode `0600` and atomically renamed
into place. A command already using the previous token may finish with it;
because renewal occurs halfway through the one-hour lifetime, both old and new
tokens remain valid across the replacement window.

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
It first reconciles an existing result and otherwise resumes the execution's
thread where possible. Only the workflow may allocate a new Agent Attempt ID
and authorize another potentially chargeable execution.

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

The initial activity-retry direction is:

| Work | Initial policy |
| --- | --- |
| Agent activity | Retry transient machinery failures, but never turn a retry into a fresh agent run. |
| Infrastructure reads | Several transient retries. |
| Idempotent infrastructure writes | Several transient retries, reconciling existing state first. |
| Invalid, permanent, or authentication failures | Never retry within the Step. |
| Rate limiting | Stop the Run and let the dispatcher cooldown policy handle it. |
| Merge | Reconcile after ambiguous failure; conflicts and head changes are domain outcomes, not retryable transport errors. |
| Recording writes | Retry firmly; fail the Run if its durable history cannot be written. |

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
  invocations only. Do not finalize that calculation until the merged versus
  deployed completion boundary is settled.

## Existing workflow histories

Do not use `workflow.GetVersion` to migrate workflows started before this
redesign. Run policy is resolved before a workflow starts and passed in its
arguments, so each workflow executes against the immutable policy snapshot it
began with. Changes to policy defaults apply to newly started workflows rather
than mutating workflows already in flight. Migration of older workflow
histories is out of scope for this work.

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
11. Renew the sandbox GitHub credential during a Run before agent execution;
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
    explicit domain budgets and named technical retry policies.

## Parked questions

### Merged versus deployed

This still needs a dedicated decision. It determines:

- whether Steps follow `merge_pull_request` in the same Run;
- whether `done` means merged or deployed;
- when dependencies become satisfied;
- how deployment is proven;
- how long the overall Run timeout must be.

No automated revert, rollback, or fix-forward design is required for that
decision. If deployment observation is included and fails, the initial model
can simply end the Run and Ticket as failed without prescribing remediation.

### Retry-policy values

The Agent Attempt timeouts, heartbeat, and agent-activity retry policy are fixed above.
Exact retry counts, backoff, and timeouts for infrastructure activities remain
undecided. They should be chosen from concrete failure scenarios rather than
inheriting the current five-control-attempt default wholesale.
