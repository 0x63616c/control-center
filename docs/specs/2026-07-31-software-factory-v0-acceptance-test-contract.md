# Software factory v0 acceptance-test contract

Status: **working behavior contract**

Companion design:
[Software factory Run, Step, and Agent Attempt design](./2026-07-31-software-factory-run-step-attempt-design.md)

This document defines observable behavior before implementation. It is not a
request to write every test in one horizontal batch. Implementation still
proceeds as vertical red-green slices: take one scenario below, write the
smallest failing test at its agreed seam, implement only enough to pass it,
then take the next scenario.

## Testing rules

- Test public behavior and durable outcomes, not private workflow helpers or
  internal call counts.
- Mock only true system boundaries: GitHub, Codex, Kubernetes, clocks, and
  process execution. Prefer real domain code and a real Postgres store.
- A Temporal workflow test observes workflow results, child behavior,
  Continue-As-New input, and effects exposed through boundary fakes. It does
  not assert an arbitrary internal helper sequence.
- Expected values are literals from this contract, not values recomputed with
  the implementation under test.
- Every persisted assertion is made through the Store or API interface a real
  caller uses. Tests do not reach through those interfaces to inspect tables.
- Native activity retries are tested through retryable boundary failures and
  workflow outcomes. Postgres must not contain a duplicate Step or Agent
  Attempt merely because Temporal retried an activity.
- Temporal replay tests remain required after the redesign. Pre-redesign
  histories are handled by the explicit quiesce/reconcile cutover and never
  replay through the new command sequence; no `workflow.GetVersion` migration
  is added.
- Replay proof includes one exported representative legacy history against the
  unchanged legacy registration before cutover and representative target
  `WorkOnTicket` and dispatcher histories after their command sequences land.

## Proposed public test seams

These seams must be agreed before implementation tests are written.

| ID | Seam | Observable contract | Harness |
| --- | --- | --- | --- |
| S1 | Dispatcher workflow | Policy publication, admission, concurrency, pause, drain, child ownership, and Continue-As-New | Temporal Go test environment with real workflow code and boundary activities |
| S2 | `WorkOnTicket` workflow | One Run's result plus Ticket, Run, Step, Attempt, PR, merge, and cleanup outcomes | Temporal Go test environment with real recording activities, Store contract fake or real Postgres, and external-edge fakes |
| S3 | Factory Store | Atomic claims/finalization, dependency readiness, idempotency, ownership checks, and ordered Run history | Real migrated Postgres through exported Store interfaces |
| S4 | GitHub client | Exact HTTP request, authoritative response parsing, and failure classification | `httptest.Server` through the concrete GitHub client |
| S5 | Agent execution activity | Resume versus fresh execution, progress heartbeats, projected-Secret credential rotation, durable transcript/result checkpointing, and cancellation | Direct activity and narrow authenticated API tests with fake clock, fake Codex process boundary, and temporary filesystem |
| S6 | Run Worker Session | Session creation and activity affinity to one private worker and filesystem | Real local Temporal server with a main worker and a separately registered Run Worker |
| S7 | Console/API read model | Ticket state, current progress, ordered Steps, Agent Attempts, results, and usage come from Postgres | API tests through the generated/public HTTP contract over a Store |
| S8 | Composition, infrastructure, and cutover | Correct workflow/activity registration, control and Run queues, pod capabilities, renewable Secrets, GitHub permissions, and proof that no old workflow remains open at deployment | Composition-root, rendered-infrastructure, and cutover-runbook tests |

The real-Temporal S6 suite is mandatory. The current unit harness can run
workflow logic with Sessions enabled, but it cannot prove that production
activity tasks are pinned to a separately deployed worker on the Run's private
task queue. Unit tests must not pretend to prove that property.

## System invariants

Every scenario below protects at least one of these invariants.

1. At most one live Run owns a Ticket, represented by an explicit durable
   `active_run_id` established atomically with Run creation.
2. Every merge authorization is tied to one head SHA that has both green CI
   and a clean internal review.
3. A Ticket becomes `done` only after a Confirmed Merge, and never moves away
   from `done` afterward.
4. A native activity retry never creates semantic work: no new Step, Review
   cycle, or Agent Attempt unless the workflow explicitly authorizes one.
5. All filesystem- and repository-affine activities from clone through merge
   execute on one active Run Worker generation and one writable filesystem at
   a time. Main-control recording, finalization, credential rotation,
   provisioning, and cleanup remain available after Session loss.
6. The Postgres Run history contains every Step and every agent execution, but
   not Temporal's individual activity tries.
7. Once GitHub has authoritatively confirmed the merge, durable success
   finalization is mandatory even if cancellation or an outage arrives next.
8. Canceling the dispatcher requests cancellation of its live Ticket Runs;
   pausing or draining does not.
9. Neither a closed-unmerged PR nor a merge webhook can mark a Ticket `done`.
10. Idle waiting and CI polling do not grow workflow history once per poll.
11. A dispatcher rolls over only after it has stopped admitting Tickets and
    reached an empty in-flight set.
12. Secrets and short-lived credentials never enter workflow inputs, results,
    logs, transcripts, or Temporal history.
13. An agent activity cannot acknowledge completion until its provider
    identity, terminal result, usage state, and transcript are durable.

## Dispatcher behavior

| ID | Given | When | Then |
| --- | --- | --- | --- |
| D01 | No dispatcher exists | A process starts its dispatcher-only control worker and publishes resolved policy with Update-With-Start | The dispatcher starts once on the control queue, accepts the policy, returns `APPLIED`, and only then may that process start its main worker |
| D02 | A dispatcher already holds the identical resolved policy | Another worker publishes the same fingerprint | The update returns `ALREADY_CURRENT`, creates no policy change, and permits startup |
| D03 | A dispatcher holds a different policy | Another worker publishes another valid resolved policy with a fresh request ID | The accepted latest arrival becomes the policy for future Runs; existing Runs keep their original input snapshot |
| D04 | Policy publication cannot be confirmed | A worker starts | The worker does not begin task-queue polling and exposes startup failure |
| D05 | No Ticket is dispatchable | `AwaitDispatchableTickets` queries Postgres | It returns the expected retryable no-work condition with a 10-second next delay and produces neither an operational error nor a workflow event per retry |
| D06 | Dispatchable Tickets exist below the concurrency cap | The wait activity returns them | The dispatcher starts children in stable order until the cap is full, and each child receives the current immutable Run Policy |
| D07 | The dispatcher is paused or at capacity | Time passes and Tickets become ready | It does not schedule a dispatch wait it cannot use and starts no child |
| D08 | A current child finishes | Its child Future resolves | Exactly that Run releases its slot; no completion signal or `DescribeRun` reconciliation is required |
| D09 | Temporal does not suggest Continue-As-New | Children start and finish | The dispatcher continues normally without an application-owned event-count threshold |
| D10 | Temporal suggests Continue-As-New while children are live | The dispatcher handles the suggestion | It enters draining, cancels any outstanding dispatch wait, admits no new Tickets, and continues processing Updates and child completion |
| D11 | A draining dispatcher receives another valid policy | Its final child later finishes | It continues as new only after `inFlight` is empty and carries the latest accepted resolved policy, with no child Future or live Run state |
| D12 | The dispatcher is canceled with live children | The parent closes | Each child receives a cancellation request; none is abandoned or abruptly terminated by parent-close policy |
| D13 | A policy publication response is lost | The same process retries with the same request ID | Temporal treats it as the same Update operation; the policy is applied at most once and startup receives the original outcome |
| D14 | A dispatcher is draining near its history budget | Policy publications continue while a child remains live | Duplicate policy is rejected as already current, only a bounded number of non-duplicate Updates are accepted, later changes receive typed `DRAINING` and retry after rollover, and the live child is neither canceled nor serialized into new input |

Child Futures are the only normal completion mechanism. Temporal reconstructs
them on replay, and the drained rollover guarantees no live Future crosses
`ContinueAsNew`. The custom completion signal and periodic `DescribeRun`
reconciliation are removed.

## `WorkOnTicket` happy path

| ID | Given | When | Then |
| --- | --- | --- | --- |
| W01 | One open Ticket | Two Runs race to claim it | Exactly one transaction creates the Run, moves the Ticket to `active`, and records that Run as owner; the loser creates no Run Worker and performs no GitHub write |
| W02 | A Run owns an `active` Ticket | The workflow starts execution | The main worker provisions one active Run Worker generation and `CreateSession` is the readiness handoff; there is no separate readiness poll |
| W03 | The Session is ready | Run execution begins | Clone is the first Run activity and executes inside the Session on the private Run Worker |
| W04 | A repository has been cloned | Plan, implementation, CI, and review succeed | Postgres exposes one ordered Step per primary operation and Agent Attempts only beneath agent-backed Steps |
| W05 | Implementation pushed a head SHA | The workflow opens or updates the PR | The PR is draft and the workflow records the authoritative PR identity and exact head SHA from GitHub, not from model prose |
| W06 | CI is green for head `H1` | Internal review returns clean for `H1` | `H1` becomes merge-authorized; neither verdict authorizes another SHA |
| W07 | `H1` is merge-authorized | The workflow reaches merge | It removes draft state and requests `merge_method=squash` with expected head `H1`; it does not request human review |
| W08 | GitHub returns HTTP success, `merged: true`, and merge SHA `M1` | The merge activity completes | The workflow treats `M1` as a Confirmed Merge |
| W09 | `M1` is a Confirmed Merge | Main-control terminal recording runs | One idempotent transaction stores `M1`, ends the Run successfully, moves only that Run's still-owned Ticket to `done`, clears ownership, and makes its dependency edges satisfied |
| W10 | Terminal recording committed | Run Worker teardown fails after its bounded retries | The workflow still returns success, the Ticket remains `done`, and the orphan sweeper can later remove the worker |
| W11 | The Ticket is `done` | A late cancellation, webhook, stale completion, or retry arrives | No operation can reopen it, fail it, duplicate dependency satisfaction, or replace `M1` |
| W12 | A successful Run completes | Its full history is read through the Store/API | Every Step and Agent Attempt is ordered and visible with results, usage, timestamps, and transcript identity; activity tries are absent |

## Feedback loops and SHA safety

| ID | Given | When | Then |
| --- | --- | --- | --- |
| F01 | A configured required check for `H1` is pending | `AwaitCI` queries check runs for SHA `H1` repeatedly | One CI Step remains active; activity retry waits 15 seconds between reads and creates no Agent Attempt or additional Step |
| F02 | CI for `H1` concludes red | The CI Step completes | A new Implement Step resumes the existing implementer Agent Thread with bounded failure evidence, then produces a new head that must run CI and review |
| F03 | Review of `H1` returns blocking findings | The Review Step completes | A new Implement Step resumes the existing implementer Thread with the findings; the next Review Step starts a fresh reviewer Thread |
| F04 | GitHub refuses the merge because of a textual conflict with current `main` | The Merge Step completes with that result | A new Implement Step receives `H1`, the current base SHA, and conflict diagnostics, resolves on the same Run Worker, and then runs CI plus a fresh Review Step |
| F05 | Another actor changes the PR head from reviewed `H1` to `H2` | The expected-head merge request is evaluated | Nothing merges under the `H1` authorization; `H2` must obtain its own green CI and clean review before another merge request |
| F06 | The merge request's response is lost | A follow-up PR read reports merge SHA `M1` | The workflow reconciles a Confirmed Merge and finalizes once rather than issuing semantically new work |
| F07 | The merge response is ambiguous and a follow-up read says the PR remains open at `H1` | The activity retries | It remains the same Merge Step and does not consume an Agent Attempt or Review cycle |
| F08 | GitHub returns a transient network or availability failure | Temporal retries the operation | It remains the same Step; a later success produces one durable Step Result |
| F09 | GitHub returns a permission or ruleset rejection | The response is classified | The workflow does not mislabel it as a textual conflict or spend semantic budget; it retries with bounded backoff for operator repair until the Run deadline, then records infrastructure failure and moves the Ticket to existing state `failed` |
| F10 | Five Review Steps have already completed and another review would be required | The workflow evaluates the loop | The Run ends exhausted without starting Review Step six or requesting merge |
| F11 | 25 Agent Attempts have been authorized and another fresh execution would be required | The workflow evaluates the retry | The Run ends exhausted without creating or running Agent Attempt 26 |
| F12 | An agent activity experiences technical failures but successfully resumes the same authorized execution | Temporal retries it | The Run records one Agent Attempt, not one Attempt per activity try |
| F13 | The base advanced and repository policy requires the branch to be current, without proving a textual conflict | GitHub refuses merge of reviewed `H1` | The workflow does not label it a conflict; an Implement Step refreshes the base, then the new head repeats CI and fresh review under the same cumulative budgets |
| F14 | Unrelated checks are green but one configured required check for `H1` is absent, pending, or red | `AwaitCI` evaluates the snapshot | It does not return green; a Run Policy with an empty required-check set is rejected before the Run starts |

## Agent execution and credential behavior

| ID | Given | When | Then |
| --- | --- | --- | --- |
| A01 | A new agent-backed Step starts | Agent Attempt 1 is authorized | The workflow records the Step and Attempt before persisting any transcript that references them |
| A02 | An implementer Step follows CI failure, review findings, or merge conflict while its Run Worker generation survives | Its Agent Attempt starts | It resumes the established implementer Agent Thread on that generation while remaining a new Step with Agent Attempt number 1 |
| A03 | A Review Step starts | A prior reviewer Thread exists | The Step starts a fresh reviewer Thread and receives the required explicit handoff data rather than relying on conversation memory |
| A04 | An agent activity try starts | GitHub credentials were minted earlier | A main-control activity updates the per-generation Secret, the Run Worker observes its non-secret revision, and per-command Git/`gh` readers use the current projected token before execution |
| A05 | One agent activity try remains active for 30 minutes | Renewal time arrives | The projected Secret is renewed without pod exec, remote file copy, restarting the Agent Attempt, or exposing the token in workflow history or a long-lived environment variable |
| A06 | An agent activity try fails transiently and Temporal retries it | The next try starts | It refreshes credentials again and reconciles or resumes the same Agent Attempt from its durable execution record |
| A07 | Agent progress events continue | More than five wall-clock minutes pass | Progress heartbeats keep the activity alive; elapsed time alone is not a heartbeat failure |
| A08 | No agent progress event occurs for five minutes | The heartbeat timeout elapses | Temporal times out that activity try and applies the native retry policy |
| A09 | A model remains unavailable across retries | Ten activity tries are consumed under 10s ×2 backoff capped at 5m | The Agent Attempt ends failed within its 90-minute Schedule-To-Close bound; no eleventh try starts |
| A10 | One activity try runs for 55 minutes | It has not completed | That try reaches Start-To-Close timeout while the Agent Attempt retains whatever Schedule-To-Close time remains |
| A11 | A completed agent result was checkpointed through the per-Run API but the activity response was lost | A retry starts | The activity reads and returns the durable result without running or charging the model again |
| A12 | An agent execution cannot be resumed and no completed result exists | The workflow still has budget | The current Agent Attempt ends failed and the workflow explicitly creates the next Attempt number before another fresh execution |

`A02` thread continuation is scoped to a surviving Run Worker generation. The
target Codex CLI does not resume a thread by provider ID from a fresh
filesystem. Permanent Run Worker loss therefore follows `A12` and `I08`: the
incomplete Attempt ends failed, and only explicit workflow authorization may
start a fresh Attempt inside the existing Run-wide budget.

## Cancellation, timeout, and irreversibility

| ID | Given | When | Then |
| --- | --- | --- | --- |
| C01 | A Run is canceled before it claims the Ticket | Cancellation is delivered | No Ticket state, Run Worker, Run record, PR, or dependency edge changes |
| C02 | A Run owns an `active` Ticket but GitHub has not confirmed a merge | Cancellation is delivered | Disconnected finalization atomically records the Run canceled and moves only that Run's still-owned Ticket to `open` |
| C03 | A Run is canceled during agent execution | The activity receives cancellation | The agent subprocess is stopped, disconnected finalization runs, and bounded Run Worker teardown follows |
| C04 | GitHub has already returned a Confirmed Merge but terminal Postgres recording has not committed | Cancellation arrives | Success finalization wins: the workflow persists the Confirmed Merge and Ticket `done` before returning; it must not reopen the Ticket |
| C05 | Terminal success has committed | Cancellation arrives during cleanup | The Ticket remains `done`; cleanup continues within its bounded policy or falls back to the sweeper |
| C06 | A child is directly terminated and cannot run workflow finalization | The scheduled `MaintainFactory` workflow observes the closed Run | The orphan Run Worker is removed and the owned `active` Ticket eventually becomes dispatchable again without pretending the terminated Run completed normally |
| C07 | Cancellation finalization retries after its transaction committed but before the activity response arrived | The retry executes | It returns the same canceled outcome and does not create another Run result or invalid state transition |
| C08 | Cancellation and success finalization race | Postgres serializes their ownership checks | The durable outcome is never both `done` and reopened; Confirmed Merge is the irreversible winner whenever it exists |
| C09 | A canceled Run left an unmerged branch or PR | A later Run reclaims the reopened Ticket | The later Run creates a fresh Run-owned branch and PR, carries useful commits forward, and ensures the old PR cannot remain merge-authorized |

### Termination reconciliation

`MaintainFactory` is a dedicated maintenance workflow invoked by a Temporal
Schedule. It reconciles both sides of abandoned ownership: a closed Ticket Run
that still owns an `active` Ticket and a Run Worker whose Run is no longer live.
The repair uses Store ownership checks before reopening the Ticket and removes
the orphaned Run Worker without representing the terminated Run as successful.
Passive lease expiry is not the recovery mechanism.

## Store contract

These scenarios run against real migrated Postgres, not only `storefake`.

| ID | Given | When | Then |
| --- | --- | --- | --- |
| P01 | One open Ticket | Two independent claims race | Exactly one atomic claim-and-Run-start transaction returns ownership and stores that Run in `active_run_id` |
| P02 | A Ticket has an unfinished direct dependency | Ready Tickets are listed | The Ticket is absent until the dependency is `done` |
| P03 | An idempotent Step or Agent Attempt start is retried | The same stable identity is written again | Exactly one logical record exists and its original identity is preserved |
| P04 | An infrastructure Step completes | Run detail is read | The Step and Result are present with zero Agent Attempts |
| P05 | An agent-backed Step executes two deliberately authorized Attempts | Run detail is read | Both Attempts appear under one Step in numeric order with independent status, usage, and transcript identity |
| P06 | Terminal success is retried | The same Run, Ticket, reviewed head, and merge SHA are supplied | The same terminal result returns and dependencies are satisfied once |
| P07 | Terminal success is called with a conflicting merge SHA after `M1` committed | The transaction evaluates it | It rejects the conflict permanently and preserves `M1` |
| P08 | Cancellation finalization names a Run that no longer owns the Ticket | It executes | It cannot reopen, fail, or otherwise mutate the Ticket |
| P09 | A transcript is persisted | Its parent Attempt does not exist | Postgres rejects it; the workflow contract ensures Attempt recording precedes transcript persistence |
| P10 | Run detail is requested | Steps and Attempts were recorded across loops and retries | The result is deterministic, oldest-first, and complete without querying Temporal |
| P11 | Legacy agent-only Step, Attempt, and transcript rows are written before and after the additive redesign migration | The final backfill runs after cutover quiescence | Every legacy record is preserved exactly once in the ordinal Step model with deterministic ordering and valid parent identities |
| P12 | A per-Run checkpoint capability is presented | It writes an Agent Attempt checkpoint | It may mutate only that owned Attempt and transcript; it cannot finalize a Ticket, change Ticket state, or write another Run |
| P13 | A repository-affine activity pushed head `H1` and synchronized PR `N` | Its durable checkpoint commits | The Store records branch, pushed head, observed base, PR number/node ID, and completed Step Result idempotently for replacement recovery |

## GitHub boundary contract

| ID | Given | When | Then |
| --- | --- | --- | --- |
| G01 | Reviewed head `H1` is merge-authorized | Merge is requested | The concrete client sends squash plus expected head `H1` to the correct repository and PR number |
| G02 | GitHub answers 200 with `merged: true` and SHA `M1` | The response is decoded | The client returns Confirmed Merge `M1` |
| G03 | GitHub answers 200 but `merged` is false or merge SHA is absent | The response is decoded | The client does not report success and preserves GitHub's bounded diagnostic for classification |
| G04 | GitHub reports the PR closed without merge | PR state is read | The client reports closed-unmerged; no workflow path treats it as success |
| G05 | A merge response was lost | Reconciliation authoritatively observes `merged: true` plus merge commit `M1` for the same PR and head | The client returns Confirmed Merge `M1`; a merely closed PR or populated `merge_commit_sha` without the merged observation is insufficient |
| G06 | GitHub reports merge conflict | The error is classified | The result is a textual-conflict domain result with bounded diagnostics, not a retryable outage |
| G07 | GitHub reports expected-head mismatch | The error is classified | The result identifies a changed head and does not authorize the replacement SHA |
| G08 | GitHub reports permission or ruleset refusal | The error is classified | The result is repairable infrastructure/configuration rejection, not conflict or model failure, so workflow policy can wait until its deadline |
| G09 | GitHub returns rate-limit or transient server failure | The error is classified | Temporal may retry it according to the GitHub activity policy |
| G10 | The workflow marks the PR ready | The GitHub request succeeds | Draft state is removed without requesting a human reviewer or enabling GitHub auto-merge |
| G11 | GitHub returns a generic merge refusal or mergeability is still computing | The client rereads the PR | It returns neither conflict nor success until authoritative head, base, state, and mergeability evidence supports that result; otherwise the same Merge Step retries |
| G12 | CI is evaluated for reviewed head `H1` | Check runs are queried | The client requests checks for commit SHA `H1`, not the branch name, and returns the configured required set separately from unrelated checks |

## Run Worker and Session integration

| ID | Given | When | Then |
| --- | --- | --- | --- |
| I01 | A main worker and Run Worker poll different task queues on a real Temporal server | `CreateSession` targets the Run Worker's private queue | Session creation succeeds only after that Run Worker is available |
| I02 | A Session is established | Clone, agent, CI, pull-request, and merge activities execute | Every repository-affine activity reports the same Run Worker identity and observes the same filesystem marker; main-control recording and Secret rotation remain callable after the Session is lost |
| I03 | The main worker is redeployed while a Run is active | Workflow tasks move to the replacement main worker | Session activities remain on the original pinned Run Worker and policy snapshot |
| I04 | Another Run Worker is polling its own private queue | The first Run schedules Session activities | No activity executes on the second Run Worker |
| I05 | The active Run Worker disappears | The Session heartbeat expires | `WorkOnTicket` uses main-control recording to close or reconcile the interrupted Attempt, provisions one replacement from the same pinned image, creates a new Session, restores the last pushed Git state plus durable Step state, and resumes after the latest completed Step without resetting budgets |
| I06 | Run Worker creation succeeds but Session creation times out | Cleanup runs | The created worker is deleted or becomes discoverable to the orphan sweeper; no Ticket is falsely marked successful |
| I07 | The Session completes | Teardown begins | No later Run activity is scheduled on the completed Session |
| I08 | Worker loss interrupts an Agent Attempt whose provider state cannot be restored | Recovery reaches the incomplete Step | The interrupted Attempt ends failed and a new Attempt may start only within the existing Run-wide budget; completed Steps never rerun |
| I09 | A Run Worker pushes and synchronizes GitHub, then dies before the activity response reaches Temporal | Recovery loads the replacement | It reconciles the durable Git/PR checkpoint and does not repeat the completed external effect or regress to an older head |

### Session recovery checkpoint

The per-Run API checkpoint is the durable recovery seam. It records the
provider thread identity as soon as Codex exposes it and stores the terminal
envelope, usage state, and transcript before activity acknowledgement. An
activity retry may resume that thread only while the same Run Worker generation
and its provider state survive. A replacement checks out the last pushed branch
but cannot use the provider ID alone to resume from its fresh filesystem; it
follows `A12` and `I08` for an incomplete Attempt. The system never claims that
the same process or unpushed filesystem state survived.

## Console, webhook, and infrastructure behavior

| ID | Given | When | Then |
| --- | --- | --- | --- |
| O01 | A Run is between Steps | The console reads its detail | It displays durable Run/Ticket state plus completed and active Step history from Postgres without querying Temporal |
| O02 | An agent activity retried technically | The console renders Agent Attempts | It shows one Attempt and does not expose Temporal tries as semantic work |
| O03 | A PR-closed webhook arrives for a merged PR | The relay processes it | No Ticket transition occurs; workflow-confirmed merge remains the only v0 completion path |
| O04 | A PR-closed webhook arrives for an unmerged PR | The relay processes it | No Ticket becomes `done` |
| O05 | The Run Worker pod is rendered | Its security and environment are inspected | It has one private task queue, an updateable projected credential directory, and a capability scoped to checkpoint its own agent work; it has no database credential, GitHub App private key, secret command-line argument, or `pods/exec` dependency |
| O06 | Workflow inputs, results, logs, and persisted transcripts are inspected in tests | Credential renewal occurs | No token or secret value is present |
| O07 | The GitHub App/ruleset configuration is rendered or verified | v0 is deployed | The App can request squash merge without human approval but cannot bypass the required CI checks the design retains |
| O08 | The old pull-request-closed completion consumer is removed | Other webhook events arrive | The shared relay continues accepting and routing supported events |
| O09 | The redesigned worker is ready to deploy | The cutover gate runs | It disables auto-merge on old factory PRs, closes every pre-redesign dispatcher/Ticket execution, reopens their nonterminal Tickets without success, and refuses deployment while any old workflow remains open |

### Progress projection

The console derives current phase from the latest active Step, falling back to
the latest terminal Step when the Run is between operations. There is no
separate mutable `run.phase` column: Step lifecycle is the authoritative domain
history and cannot disagree with a duplicated projection.

## First vertical TDD slices

Implementation should take these as tracer bullets rather than writing the
whole suite before production code:

1. Real-Postgres Confirmed Merge transaction (`P06`, `P07`, `W09`).
2. GitHub exact-SHA squash merge and response classification (`G01`-`G09`).
3. Minimal `WorkOnTicket` happy path through Confirmed Merge (`W01`-`W11`).
4. CI pending/red feedback (`F01`, `F02`).
5. Review feedback and cumulative review budget (`F03`, `F10`).
6. Textual merge-conflict feedback (`F04`) and changed-head invalidation
   (`F05`).
7. Agent Attempt checkpoint recovery and total budget (`A01`-`A12`, `F11`,
   `F12`, `P12`).
8. Cancellation and irreversible finalization (`C01`-`C08`).
9. Retry-backed dispatcher wait and acknowledged policy publication
   (`D01`-`D07`, `D13`).
10. Drained Continue-As-New and child cancellation ownership
    (`D08`-`D12`, `D14`).
11. Real-Temporal Run Worker Session affinity and replacement (`I01`-`I08`).
12. Legacy Postgres-history migration (`P11`).
13. Console projection, webhook retirement, security assertions, and cutover
    gate (`O01`-`O09`).

After this behavior contract is aligned, the fresh reviewer should critique
both documents together. A finding against prose that is already contradicted
by an acceptance scenario is actionable; a finding that requires changing a
scenario exposes a real product decision rather than an implementation detail.
