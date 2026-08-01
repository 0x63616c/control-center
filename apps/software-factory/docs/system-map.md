# The software factory, end to end, as it is today

What happens when a ticket gets worked. This is an operational map of the
current implementation, not ADR-0011's historical design rationale. It names
the source symbols that own the behavior so a future change can be checked at
the source rather than preserving this prose by inertia.

Read it to answer: what reads what, what can write, what is trusted for what,
where a model sits, where a human is required — and what is absent.

## One glance

```
a `ready` Ticket in the factory's own Postgres
        │
        │ dispatcher: one long-running Temporal workflow
        │ claim: workflow-ID uniqueness on `factory-ticket-<id>`
        ▼
factory-ticket-<id> (child workflow; one disposable sandbox pod)
        │
        ├─ TransitionTicketState open → working
        ├─ CreateSandbox → WaitSandboxReady → CloneRepo
        ├─ AgentWorkflow(plan/1): main-worker model calls + sandbox tools
        │
        │    ┌─ AgentWorkflow(implement/N) → draft PR → observe CI ─────────┐
        │    │       ▲ red or not concluded                                  │
        │    │       └──────────────────────────────────────────────────────┘
        │    │
        │    └─ green CI → AgentWorkflow(review/N)
        │                     │ blocking finding
        │                     └──────────────► a fresh implement window
        │
        └─ finish: delete sandbox, record the run's end and transition the
                   Ticket; a clean review makes the draft PR ready for human
                   review and enables auto-merge
        ▼
human approval → GitHub auto-merges when requirements are satisfied → deploy
```

The fixed first pass is `plan → implement → review`, defined by
`work.Pipeline`. It is not a forward-only schedule:
`factoryTicketRun.factoryImplementReviewLoop` repeats implement while CI is red or unobserved, and starts another CI window
after a blocking review finding. A blocked implement verdict, stalled or
exhausted CI/review progress, or an activity failure terminates the run.

That diagram is the deployed legacy workflow. The additive target Store uses
an ownership-bearing `active` Ticket state instead of `working`/`review`: an
atomic claim sets `active_run_id`, and only that Run may checkpoint or release
the Ticket. The API accepts and projects all six schema states during the
cutover: `open`, target `active`, legacy `working` and `review`, `done`, and
`failed`.

## The control plane

### Dispatcher

`FactoryDispatcher` is a timer loop, not a Temporal Schedule. It applies any
`UpdateConfig` signal that arrived, drains completion signals, reconciles known
child workflows, sweeps orphaned sandboxes, then lists `ready` Tickets and
starts as many as its in-flight cap allows. Starting the child workflow with ID
`factory-ticket-<id>` is the claim: Temporal will not allow another open
workflow with the same ID. See `workflows/factory_dispatcher.go` and
`work.FactoryTicketWorkflowID`.

**`dispatcher_state` is retired.** The row and its `RecordDispatcherState`
activity were written by the retired GitHub-backed dispatcher (#551), and #559
deleted the only caller. The console no longer reads or exposes that stale
GitHub-Issue projection; its list is derived only from factory Tickets.

The configured defaults are owned by `work.DefaultFactoryConfig` and
`work.DefaultDispatcherTuning`: one in flight, a 30-second poll interval, a
30-minute orphan grace, and `gpt-5.6-terra` at medium effort unless a stage
override is configured. There is no `DISPATCHER_CONFIG` environment variable
any more — a live change is the `UpdateConfig` signal the API sends.

The HTTP API (`internal/api`) is reached at `factory.worldwidewebb.co` through
Cloudflare Access. The tunnel targets the namespace-local `web` Service; nginx
serves the console and proxies `/api/*` to the namespace-local `api` Service.
The API applies migrations before its readiness endpoint can answer. Both API and
console run without Kubernetes credentials; only the worker mounts a Kubernetes
token. Transcript and conversation bytes use the blob service and factory Store.
Its authenticated write commands use `internal/clients/temporal.Commands` to
send `workflows.SignalUpdateConfig` to `work.FactoryDispatcherWorkflowID`
(pause, resume, max-in-flight, or an empty update that wakes the next tick);
the console never connects to Temporal. Cancelling a Ticket asks Temporal to
cancel the `work.FactoryTicketWorkflowID` run so its disconnected cleanup can
delete the sandbox. There is no status query: `workflows.QueryStatus` belonged
to the retired dispatcher and went with it (#559).
Command acceptance means Temporal accepted the request, not that the database
has observed its effect.

### Pipeline identity namespace

One pipeline, one identity namespace:

| Temporal workflow ID | branch |
|---|---|
| `factory-ticket-<id>` (`work.FactoryTicketWorkflowID`) | `software-factory/factory-ticket-<id>/<runID>` (`work.FactoryTicketBranchName`) |

The `factory-ticket-` prefix must not be reused for anything else, and in
particular must stay disjoint from the retired `work-ticket-<n>` scheme:
Temporal can reuse a closed workflow ID, so a small Ticket id under that prefix
would share a history lineage with the GitHub issue of the same number. One
branch constructor keeps the sandbox branch and the PR head aligned; see
`SandboxTemplate.SpecForFactoryTicket` for the #603 fix.

### Work ticket and deadlines

`factoryTicketRun.execute` claims the Ticket, performs setup, runs the one plan
child, then calls `factoryImplementReviewLoop`. Each stage is a synchronous
`AgentWorkflow` child. The child creates its own Session for sandbox-affine tool
activities; prompt, model and finalization activities stay on the main queue.
Cleanup is run on a disconnected workflow context so cancellation does not
strand the sandbox.

`work.DefaultRunPolicy` and `work/durations.go` own the deadline ladder:

| bound | value |
|---|---:|
| stage timeout | 60 minutes |
| stage heartbeat timeout | 5 minutes |
| stage activity retries | bounded exponential backoff; see `work.DefaultRunPolicy` and `work.StageRetry*` |
| run timeout | 24 hours |
| sandbox `activeDeadlineSeconds` | 25 hours |
| control activity timeout / attempts | 2 minutes / 5 |

The theoretical maximum is 19 stage invocations: one plan, up to 15 implement
turns (three CI windows of five), and up to three reviews. `work.MaxStageInvocations`
and `RunPolicy.Validate` centralize and check that arithmetic against the
24-hour run budget.

## The three stage contracts

Every stage starts an `AgentWorkflow` child with a versioned toolset. Direct
subscription-backed Responses calls and OAuth credentials stay on the main
worker. Only typed tool calls cross onto the sandbox Session queue. Tool schemas
are reflected from Go input types at startup, strict-decoded at runtime and
fingerprinted as part of an immutable toolset. There are no handwritten JSON
tool schema files.

| stage | purpose and inputs | write/trust boundary |
|---|---|---|
| `plan` | Turn the ticket and discussion into an implementation plan. | Receives `coding-read-v1`; its document guides implement but workflow code does not act on it directly. |
| `implement` | Change, verify, commit, and push the checked-out branch using the plan, its own previous report, and the latest review findings. | The only intended writing stage. It returns `report`, `blocked`, `blocked_reason`, `title`, and `body`. |
| `review` | Fresh adversarial review of the implementation after green CI, using the report and previous review findings. | Receives `coding-read-v1`. It returns a document plus structured, stable-ID findings; blocking findings control the next loop decision. |

`work.ImplementOutput` and `work.ReviewOutput` define these structured
contracts. `work.PriorTurns` limits each stage activity input to the plan and
the latest implement/review outputs; the workflow separately retains the full
ordered turn history for CI and repeated-finding progress checks.

Each invocation is a separate child workflow with a deterministic ID of
`agent/<run-id>/<stage>/<turn>`. Conversation revisions and tool arguments are
blob-backed references, not growing values copied into every history event.
The bounded `work.PriorTurns` handoff carries the plan, latest implement and
latest review result into the next semantic stage.

### Pull request and CI ownership

After every non-blocked implement return, `factoryImplementReviewLoop` calls
`openOrUpdatePullRequest`. Workflow code finds or creates the pull request for
the branch it named, makes it draft-first, and uses implement's title/body as
descriptive content; the model supplies no PR identifier and does not execute a
separate PR-opening stage. `observeCI` runs before review. A clean review ends
with `OutcomeProposed`; `factoryTicketRun.finish` makes the draft ready for
review, enables auto-merge and transitions the Ticket to `review`. Required GitHub review/approval remains outside the
pipeline.

## Prompt fences and records

`internal/prompts/templates/base.md` fences Ticket title, body, and
prior-stage documents with an untrusted-content nonce. The renderer generates
and removes the nonce from untrusted input, then checks fence counts. This is a
prompt-injection mitigation, not an authorization boundary: plan, report, and
review prose can still be fallible and must be checked by the stage reading it.

The durable record locations are:

| record | where |
|---|---|
| workflow decisions and state | Temporal history in the `software-factory` namespace |
| raw stage event stream | transcript sink under the configured transcript root |
| human-facing progress | the console, over the run/step/attempt rows below. The factory posts nothing to GitHub except the pull request itself (ADR-0012, #559). |
| outcomes and usage | workflow result, Attempt rows, and Prometheus metrics |
| worker logs | Loki |
| run/step/attempt rows (ADR-0012) | `internal/store`'s Postgres tables, written through `internal/activities.RecordingActivities` as the run happens |
| transcript rows (ADR-0012) | `internal/store`'s `transcript` table, written through `internal/activities.TranscriptRecordingActivities.PersistTranscriptToStore` |

`factoryTicketRun.persistTranscript` deliberately runs on the main worker queue:
the stage that produced the bytes ran on the sandbox's own Session queue, and
the database is reachable only from the main worker.

## How the factory learns a pull request merged (#557)

The pipeline above never polls GitHub for pull request state. The public
webhook relay (#535, `apps/software-factory/cmd/relay`) verifies each GitHub
delivery once and forwards it, independently, to every configured target;
`internal/webhook.Handler` is the factory's own target, mounted at
`/v1/hooks/github` on the factory API — deliberately outside the API's
Cloudflare Access/bearer middleware, since its caller is the relay rather than
a human or an agent, and it authenticates each delivery itself, by HMAC
(duplicating the relay's own verification until #532 closes the in-cluster
network hole; see `internal/webhook`'s own doc comment).

It acts on exactly one thing: a `pull_request` `closed` event whose branch
`internal/work.ParseFactoryTicketBranchName` resolves to a factory Ticket.
`store.RecordWebhookDeliveryAndTransition` records the GitHub delivery id and
applies the Ticket's `review -> done` (merged) or `review -> failed` (closed
unmerged) transition in one Postgres transaction, so acknowledging the
delivery and having durably acted on it are the same fact — there is no window
after the response in which the effect could still be lost, and no separate
queue or worker is needed. `done` is what ADR-0012's `ready(T)` reads to
unblock a Ticket's dependents; this is the only thing in the factory that ever
sets it. This is unrelated to the legacy pipeline's own PR lifecycle described
under "Where a human is required" below, which still relies on GitHub
auto-merge and carries no Ticket to transition.

## Sandbox and retries

`CreateSandbox` creates one `restartPolicy: Never` pod per ticket. It has an
`emptyDir` work volume, no provider credential, no automatically mounted
service-account token, a non-root security context, no privilege escalation,
and all Linux capabilities dropped. The main worker registers `AgentWorkflow`
plus prompt, model, finalization and transcript activities. The sandbox worker
registers only the generic typed `agent.tool` activity and hosts one concurrent
Temporal Session. Tool calls are Session-bound to the run-specific sandbox
queue, which only that sandbox pod polls.

Each child workflow is parent-owned with request-cancel close policy and waits
for cancellation. Model activity cancellation closes the HTTP request; tool
activity cancellation kills the local process. A sandbox-pod loss fails the
Session (`workflow.ErrSessionFailed`); the pod's `emptyDir` checkout is gone and
cannot be resumed. The parent always runs sandbox deletion on its disconnected
cleanup context.

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

1. File the Ticket, through the API or the console. The service never files
   its own.
2. Review and approve a successful PR. The workflow opens/updates the draft,
   but approval is a GitHub policy decision.
3. GitHub auto-merges after approval and any other required checks complete.
   A human can still merge manually if arming auto-merge failed; merging deploys.
4. Resolve a blocked, exhausted, or failed outcome and move the Ticket back to
   `open` if another machine pass is wanted. `failed` never auto-retries.
5. Re-seed Codex credentials if their refresh credential becomes unusable.

## Current limitations

- The sandbox has no network isolation: the cluster currently has no effective
  egress policy for it.
- The agent can read its GitHub credential inside the sandbox ([#416][416]).
- The installation token is not refreshed during a run ([#417][417]); the run
  budget is now 24 hours, so the issue title's former six-hour wording is
  historical rather than a current duration.

## Open tickets this map makes legible

- [#416][416] — agent-readable GitHub token.
- [#417][417] — installation-token refresh during the now-longer run budget.

Resolved historical context deliberately omitted here: #415's output-contract
work, #425's generic activity-name problem, #428's sandbox-toolchain work, and
#331's status-token accounting item are closed and are not current open work.

[416]: https://github.com/0x63616c/world-wide-webb/issues/416
[417]: https://github.com/0x63616c/world-wide-webb/issues/417
