# Software factory Run, Step, and Attempt design

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
- one visible model of machine Attempts and retries;
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

> A Step is executor-neutral. An Attempt is executor-neutral. Agent-specific
> information hangs off an Attempt only when that Attempt ran an agent.

Do not add nullable model, token, and transcript fields to every infrastructure
Attempt.

```text
Ticket
  Run
    Step
      Attempt
        AgentAttempt details, when applicable
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

attempt
  step_id
  attempt_no
  state
  started_at
  ended_at
  failure_kind
  retry_decision

agent_attempt
  attempt_id
  agent_stage
  model
  effort
  execution_mode
  usage_state
  input_tokens
  cached_input_tokens
  output_tokens
  reasoning_tokens
  thread_id

transcript
  attempt_id
  ...
```

An infrastructure Attempt only uses the common `attempt` row. An agent Attempt
also gets an `agent_attempt` row.

For example:

```text
Step: prepare_workspace
  Attempt 1: failed, transient Kubernetes error
  Attempt 2: succeeded

Step: implement, iteration 1
  Attempt 1: failed, heartbeat timeout
    Agent: gpt-5.6-terra / medium
    Usage: unknown
  Attempt 2: succeeded
    Agent: gpt-5.6-terra / medium
    Execution: resumed
    Usage: not applicable
    Transcript: available
```

The distinction between `unknown` and `not applicable` improves the existing
`measured` flag:

- `measured`: the agent ran and usage was captured;
- `unknown`: it may have run, but usage was lost;
- `not_applicable`: this Attempt did not run an agent, such as a resumed result.

Today, a resumed Attempt is marked unmeasured, which makes the whole rollup
unknown. Really, the lost usage belongs to the preceding failed Attempt, while
the resumed Attempt spent nothing.

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

## Step boundary

This is decided:

> A Step is one independently attempted and retried unit of workflow work.

A Step has exactly one primary operation. Executions of that primary operation
are the Step's Attempts. This normally produces a one-to-one relationship
between a user-meaningful Step and a named Temporal activity, but it does not
mean every Temporal activity is a Step.

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
such as `RecordStep`, `RecordAttemptStart`, `RecordAttemptEnd`, and
`RecordRunEnd`, plus workflow timers used for retry backoff. Otherwise recording
a Step would recursively require another recorded Step.

If several operations each need their own retry policy or independently useful
outcome, they are separate Steps. If several low-level operations truly form
one retryable goal, prefer deepening them behind one named, idempotent primary
activity.

## Attempt status and Step Result

This is decided:

> Attempt status says whether one execution worked. Step Result says what the
> operation authoritatively discovered or produced.

A successful Attempt does not imply that the workflow achieved its desired
business result. It means the Step's primary operation completed and returned
an authoritative answer.

For example:

| Step | Attempt status | Step Result | Workflow decision |
| --- | --- | --- | --- |
| `observe_ci` | `succeeded` | `ci_green` | Continue to review. |
| `observe_ci` | `succeeded` | `ci_red` | Create another `implement` Step. |
| `merge_pull_request` | `succeeded` | `merged` | Continue past the merge boundary. |
| `merge_pull_request` | `succeeded` | `merge_conflict` | Create another `implement` Step. |
| `implement` | `succeeded` | `blocked` | End the Run without retrying identical work. |
| Any primary operation | `failed` | none | Apply the Step's retry policy. |

A timeout, crashed process, or transport failure is an Attempt execution
failure. A red CI result or merge conflict is not. Retrying the former may
create another Attempt of the same Step; responding to the latter creates a
different Step or ends the Run.

A Step is `running` while an Attempt or its retry wait is active. It becomes
`completed` when an Attempt returns a domain Result, including results such as
`ci_red`, `merge_conflict`, or `blocked`. It becomes `failed` only when its
Attempt budget is exhausted or an execution error is non-retryable.

This keeps three questions separate:

```text
Attempt status = did this execution work?
Step Result    = what did the operation discover or produce?
Workflow       = what Step should happen next?
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

A private workflow helper can wrap those activities with Step and Attempt
recording:

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
  begin Attempt
    execute named activity
  finish Attempt
  decide whether to retry
finish Step
```

For agent activities, `runAgentStep` can be a thin layer over the same primitive
that adds model, usage, transcript, and thread information. It is not a second
Step system.

A user-meaningful Step has one primary named activity. Where the workflow
currently uses multiple low-level activities for one action, for example
`FindPullRequest` followed by `OpenOrUpdatePullRequest`, deepen that operation
into one idempotent `SyncPullRequest` activity when practical. Both Temporal and
the console then show a useful name without exposing implementation chatter.

Database-recording activities are deliberately not Steps. Otherwise recording
a Step would require recording the recording Step recursively.

## Attempt policy

The current system is materially incomplete here.

The workflow permits up to six Temporal retries for an agent stage and five for
control work, but Postgres always records `attemptNo = 1`. The code explicitly
says distinguishing Temporal retries was postponed.

To retain every Attempt, the workflow must own the retry loop:

1. Set `MaximumAttempts: 1` on the primary Step activity.
2. Persist Attempt 1 before scheduling it.
3. Execute the named activity once.
4. Persist its outcome.
5. Classify the failure.
6. Schedule Attempt 2 explicitly when policy permits.

Temporal's automatic retries currently hide intermediate failures from workflow
code. An explicit loop makes every real Attempt visible in Postgres while
retaining Temporal durability and replay.

Recording writes themselves can keep automatic Temporal retries. They are
persistence plumbing, not Ticket work. They should become mandatory: currently
Step and Attempt writes are logged and ignored after exhausting retries, despite
the system's stated goal that the console is authoritative.

The initial retry-policy direction is:

| Work | Initial policy |
| --- | --- |
| Agent execution | Very conservative; no six potentially chargeable reruns. |
| Infrastructure reads | Several transient retries. |
| Idempotent infrastructure writes | Several transient retries, reconciling existing state first. |
| Invalid, permanent, or authentication failures | Never retry within the Step. |
| Rate limiting | Stop the Run and let the dispatcher cooldown policy handle it. |
| Merge | Reconcile after ambiguous failure; conflicts and head changes are domain outcomes, not retryable transport errors. |
| Recording writes | Retry firmly; fail the Run if its durable history cannot be written. |

For agent work, consider two limits:

```text
maximum Attempts
maximum possibly-chargeable executions
```

A retry that safely resumes an existing result should not consume the same
budget as another full agent execution. A timeout where the system cannot prove
whether the agent ran should count as potentially chargeable.

These remain different concepts:

- An **Attempt** is a machine retry of identical work.
- A new `implement` Step after red CI is semantic rework.
- A new `implement` Step after review findings is semantic rework.
- The existing implement and review turn ceilings are progress budgets, not
  retry counts.

## Existing assumptions that must change

This reaches further than a database migration:

- `Step` is currently an alias for agent-only `StageKey`.
- The database requires every Attempt to have model, effort, tokens, and
  `measured`.
- Attempt number is always hard-coded to `1`.
- Step and Attempt recording is currently best-effort.
- Usage rollups treat every Attempt as an agent Attempt.
- Transcript identity and API routes are based on `stage/turn`.
- Metrics are agent-stage-specific. They should remain so, with separate
  generic Step metrics if they become useful.
- `RunPolicy` divides work into `StageAttempts` and `ControlAttempts`.
- The 24-hour Run budget is calculated from the maximum number of agent
  invocations only. Do not finalize that calculation until the merged versus
  deployed completion boundary is settled.
- Changing the workflow's activity and retry command sequence requires a
  Temporal `workflow.GetVersion` compatibility branch for existing histories.

## Current design direction

1. Generalize Step around `kind + ordinal`.
2. Rename the existing Stage concept to AgentStage.
3. Keep Step and Attempt executor-neutral.
4. Put agent details in a one-to-zero-or-one AgentAttempt record.
5. Keep concrete, well-named Temporal activities.
6. Move retries into a workflow-owned, persisted Attempt loop.
7. Keep semantic-rework budgets separate from infrastructure retry policy.
8. Give every Step exactly one primary operation; its executions are the Step's
   Attempts.
9. Keep Attempt execution status separate from the Step's domain Result.

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

The policy categories and ownership are proposed above, but the exact maximum
Attempts, backoff, and possibly-chargeable execution limits are not yet fixed.
They should be decided using concrete failure scenarios rather than copying the
current six-stage-attempt and five-control-attempt defaults.
