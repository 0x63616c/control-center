# The software factory, end to end, as it is today

What happens when a ticket gets worked. This is an operational map of the
current implementation, not ADR-0011's historical design rationale. It names
the source symbols that own the behavior so a future change can be checked at
the source rather than preserving this prose by inertia.

Read it to answer: what reads what, what can write, what is trusted for what,
where a model sits, where a human is required — and what is absent.

## One glance

```
GitHub issue labelled `auto`
        │
        │ dispatcher: one long-running Temporal workflow
        │ claim: workflow-ID uniqueness on `work-ticket-<n>`
        ▼
work-ticket-<n> (child workflow; one disposable sandbox pod)
        │
        ├─ FetchTicketDetail
        ├─ CreateSandbox → WaitSandboxReady → CloneRepo
        ├─ Create one Temporal Session on this run's sandbox task queue
        ├─ plan (once)
        │
        │    ┌─ implement → workflow creates/updates draft PR → observe CI ─┐
        │    │       ▲ red or not concluded                                  │
        │    │       └──────────────────────────────────────────────────────┘
        │    │
        │    └─ green CI → fresh review
        │                     │ blocking finding
        │                     └──────────────► a fresh implement window
        │
        └─ finish: delete sandbox, update labels/status; a clean review makes
                   the draft PR ready for human review and enables auto-merge
        ▼
human approval → GitHub auto-merges when requirements are satisfied → deploy
```

The fixed first pass is `plan → implement → review`, defined by
`work.Pipeline`. It is not a forward-only schedule: `ticketRun.implementReviewLoop`
repeats implement while CI is red or unobserved, and starts another CI window
after a blocking review finding. A blocked implement verdict, stalled or
exhausted CI/review progress, or an activity failure terminates the run.

## The control plane

### Dispatcher

`DispatcherWorkflow` is a timer loop, not a Temporal Schedule. It reconciles
known child workflows, prunes completed work, sweeps orphaned sandboxes, then
lists and starts eligible `auto` tickets while below its in-flight cap. Starting
the child workflow with ID `work-ticket-<n>` is the claim: Temporal will not
allow another open workflow with the same ID. See `workflows/dispatcher.go` and
the `work.WorkflowID` helpers.

The configured defaults are owned by `work.DefaultConfig` and
`work.DefaultDispatcherTuning`: three in flight, a 30-second poll interval, a
15-minute breaker cooldown, a 30-minute orphan grace, and `gpt-5.6-terra` at
medium effort unless a stage override is configured.

The HTTP API (`internal/api`) is reached at `factory.worldwidewebb.co` through
Cloudflare Access. The tunnel targets the namespace-local `web` Service; nginx
serves the console and proxies `/api/*` to the namespace-local `api` Service.
The API applies migrations before its readiness endpoint can answer. Both API and
console run without Kubernetes credentials or transcript storage; only the worker
mounts the Kubernetes token and transcript volume.
Its authenticated write commands use `internal/clients/temporal.Commands` to
send the dispatcher's existing `workflows.SignalUpdateConfig` signal (pause,
resume, max-in-flight, or an empty update that wakes the next tick); the
console never connects to Temporal. `workflows.QueryStatus` remains the one
status query, while cancelling a ticket asks Temporal to cancel the
`work.WorkflowID` run so its disconnected cleanup can delete the sandbox.
Command acceptance means Temporal accepted the request, not that the database
has observed its effect.

### Work ticket and deadlines

`ticketRun.execute` performs setup, creates exactly one Session, runs the one
plan turn, then calls `implementReviewLoop`. Cleanup is run on a disconnected
workflow context so cancellation does not strand the sandbox.

`work.DefaultRunPolicy` and `work/durations.go` own the deadline ladder:

| bound | value |
|---|---:|
| stage timeout | 60 minutes |
| stage heartbeat timeout | 1 minute |
| stage activity attempts | 2 |
| run timeout | 24 hours |
| sandbox `activeDeadlineSeconds` | 25 hours |
| control activity timeout / attempts | 2 minutes / 5 |

The theoretical maximum is 19 stage invocations: one plan, up to 15 implement
turns (three CI windows of five), and up to three reviews. `work.MaxStageInvocations`
and `RunPolicy.Validate` centralize and check that arithmetic against the
24-hour run budget.

## The three stage contracts

Every stage invokes `codex exec` in the sandbox through the codex client. The
runner sends the rendered prompt on standard input, records it as `prompt.md`,
and uses explicit argv rather than a shell command. The sandbox has the same
credentials and bypassed Codex sandboxing for every stage, so read-only status
is instruction, not capability enforcement.

| stage | purpose and inputs | write/trust boundary |
|---|---|---|
| `plan` | Turn the ticket and discussion into an implementation plan. | Prompt says read-only; its document guides implement but workflow code does not act on it directly. |
| `implement` | Change, verify, commit, and push the checked-out branch using the plan, its own previous report, and the latest review findings. | The only intended writing stage. It returns `report`, `blocked`, `blocked_reason`, `title`, and `body`. |
| `review` | Fresh adversarial review of the implementation after green CI, using the report and previous review findings. | Prompt says read-only. It returns a document plus structured, stable-ID findings; blocking findings control the next loop decision. |

`work.ImplementOutput` and `work.ReviewOutput` define these structured
contracts. `work.PriorTurns` limits each stage activity input to the plan and
the latest implement/review outputs; the workflow separately retains the full
ordered turn history for CI and repeated-finding progress checks.

Each invocation is a separate agent process. Later implement turns resume the
implement conversation, whereas every review turn is a fresh thread. The
prompt templates explicitly pass the last handoff values because a new process
does not otherwise know the earlier turn.

### Pull request and CI ownership

After every non-blocked implement return, `implementReviewLoop` calls
`openOrUpdatePullRequest`. Workflow code finds or creates the pull request for
the branch it named, makes it draft-first, and uses implement's title/body as
descriptive content; the model supplies no PR identifier and does not execute a
separate PR-opening stage. `observeCI` runs before review. A clean review ends
with `OutcomeProposed`; `ticketRun.finish` makes the draft ready for review and
enables auto-merge. Required GitHub review/approval remains outside the
pipeline.

## Prompt fences and records

`internal/prompts/templates/base.md` fences issue title, body, comments, and
prior-stage documents with an untrusted-content nonce. The renderer generates
and removes the nonce from untrusted input, then checks fence counts. This is a
prompt-injection mitigation, not an authorization boundary: plan, report, and
review prose can still be fallible and must be checked by the stage reading it.

The durable record locations are:

| record | where |
|---|---|
| workflow decisions and state | Temporal history in the `software-factory` namespace |
| raw stage event stream | transcript sink under the configured transcript root |
| human-facing progress | one edited status comment per run step |
| outcomes and usage | workflow result, outcome comment, and Prometheus metrics |
| worker logs | Loki |
| run/step/attempt rows (ADR-0012) | `internal/store`'s Postgres tables, written through `internal/activities.RecordingActivities` — not yet registered on any task queue. `run.ticket_id` is a NOT NULL foreign key to a factory-owned Ticket, which a GitHub-issue-driven run has no equivalent of and ADR-0012 forbids bridging one for, so `Dispatcher` and `WorkTicket` above are unmodified and do not call it. software-factory#558's Ticket-driven workflow is this record's one intended caller. |
| transcript rows (ADR-0012) | `internal/store`'s `transcript` table, written through `internal/activities.TranscriptRecordingActivities.PersistTranscriptToStore` — a distinct activity from the `PersistTranscript` row above, and, like `RecordingActivities`, not yet registered on any task queue for the same reason: a transcript row's foreign key requires an Attempt, which only software-factory#558's Ticket-driven workflow ever records. The existing `PersistTranscript`/NFS path above is unmodified and keeps serving the running pipeline until #559 retires it. |

`ticketRun.persistTranscript` deliberately runs on the main worker queue and
is best-effort: a transcript relay failure does not discard a run's work.

## Sandbox and retries

`CreateSandbox` creates one `restartPolicy: Never` pod per ticket. It has an
`emptyDir` work volume, a per-ticket credential Secret, no automatically
mounted service-account token, a non-root security context, no privilege
escalation, and all Linux capabilities dropped. Both workers register activity
methods: the main worker registers the complete `Activities` object on its
main queue, while the sandbox worker explicitly registers `RunPlan`,
`RunImplement`, and `RunReview` and enables one concurrent Temporal Session.
Stage calls are Session-bound to the run-specific sandbox queue, which only
that sandbox pod polls; main-queue registration does not make the main worker
an executor for those Session-bound stage calls.

The stage activity retry policy is still two attempts, but it applies on the
Session's run-specific sandbox queue. A rollout of the main worker can resume
workflow/control work without itself consuming a stage attempt. A sandbox-pod
loss instead fails the Session (`workflow.ErrSessionFailed`); the pod's
`emptyDir`, including the checkout and any unrelayed transcript, is gone and
cannot be resumed. A heartbeat timeout, Codex/process failure, or stage timeout
can also consume the retry budget.

The sandbox image includes Node, Go, `gcc`/`libc6-dev`, and a pinned
`golangci-lint`; the previous toolchain-gap warning no longer applies. It also
ships checksum-pinned Playwright Chromium at `/ms-playwright`; Playwright's
dependency resolver supplies the native Trixie libraries, and the smoke test
proves uid 1000 can write a real headless page PNG while `/work` is masked.
The resolver also supplies Xvfb and `xauth`; smoke keeps a headed Chromium
window open at a 1366×1024 page viewport on a 1400×1100 display, so browser
chrome does not silently shrink the panel viewport. Playwright page PNGs remain
headless and do not themselves capture native browser chrome.

## Where a human is required

1. File the issue and add the `auto` label. The service never adds it.
2. Review and approve a successful PR. The workflow opens/updates the draft,
   but approval is a GitHub policy decision.
3. GitHub auto-merges after approval and any other required checks complete.
   A human can still merge manually if arming auto-merge failed; merging deploys.
4. Resolve a blocked, exhausted, or failed outcome and re-add `auto` if another
   machine pass is wanted.
5. Re-seed Codex credentials if their refresh credential becomes unusable.

## Current limitations

- Read-only stages have prompt-only, not capability, enforcement.
- The sandbox has no network isolation: the cluster currently has no effective
  egress policy for it.
- The agent can read its GitHub credential inside the sandbox ([#416][416]).
- The installation token is not refreshed during a run ([#417][417]); the run
  budget is now 24 hours, so the issue title's former six-hour wording is
  historical rather than a current duration.
- Liveness and transcript collection remain coupled to the sandbox stream
  ([#424][424]).
- A resumed stage can render zero usage as measured because `UsageMeasured` is
  not consumed ([#426][426]).
- The transcript PV is backed by the wider shared NFS export despite the
  worker's subpath mount ([#412][412]).

## Open tickets this map makes legible

- [#412][412] — transcript storage scope.
- [#416][416] — agent-readable GitHub token.
- [#417][417] — installation-token refresh during the now-longer run budget.
- [#424][424] — stage liveness/transcript stream coupling.
- [#426][426] — cached-stage usage rendered as measured zero.

Resolved historical context deliberately omitted here: #415's output-contract
work, #425's generic activity-name problem, #428's sandbox-toolchain work, and
#331's status-token accounting item are closed and are not current open work.

[412]: https://github.com/0x63616c/world-wide-webb/issues/412
[416]: https://github.com/0x63616c/world-wide-webb/issues/416
[417]: https://github.com/0x63616c/world-wide-webb/issues/417
[424]: https://github.com/0x63616c/world-wide-webb/issues/424
[426]: https://github.com/0x63616c/world-wide-webb/issues/426
