# Software Factory Agent Workflow

**Status:** implemented; local runtime acceptance and production cutover remain
**Date:** 2026-07-31  
**Scope:** `apps/software-factory`  
**Goal:** new software-factory Runs execute every plan, implement and review Step through a reusable Temporal `AgentWorkflow`; the production sandbox no longer installs or invokes the Codex CLI.

## Outcome

`FactoryWorkTicket` remains the business workflow. It owns the Ticket, Run, Step sequence, semantic budgets, pull request state, CI observation and terminal outcome. It starts one synchronous `AgentWorkflow` child for each plan, implement or review Step.

`AgentWorkflow` is the reusable agent runtime. It owns one bounded model/tool loop, its conversation, tool execution, provider usage and transcript. It returns one typed stage result to its parent. It does not know about Tickets, pull requests, CI or the factory's implement/review loop.

The Codex CLI is not a provider adapter. New Runs do not call `codex exec`, do not resume a Codex thread, do not install the Codex binary in the sandbox image and do not construct Codex CLI argv. The existing subscription-backed Responses HTTP client and durable OAuth source become the model adapter used by production activities.

```text
FactoryWorkTicket
  |
  +-- prepare sandbox and clone repository
  |
  +-- AgentWorkflow(plan/1) ----------+
  |     model activity (main queue)   |
  |     tool activity (sandbox Session)
  |     model activity (main queue)   |
  +<----------------------------------+
  |
  +-- AgentWorkflow(implement/N) ...
  +-- GitHub and CI decisions
  +-- AgentWorkflow(review/N) ...
  +-- terminal Ticket/Run decision
```

## Starting point (retired by this implementation)

The merged direct-Responses proof already establishes the risky transport facts:

- a Go HTTP/SSE client can use the durable subscription-backed OAuth credential;
- a Temporal workflow can distinguish final text from function calls;
- provider calls and tool calls can be separate retrying activities;
- a worker restart does not lose the workflow's durable loop state;
- the shared payload codec compresses and blob-offloads large Temporal payloads.

Before this change the proof was isolated under `agentpoc`; production rendered a stage prompt, wrote a schema file and invoked the CLI inside a sandbox-side stage activity. That isolated POC, the CLI client and the sandbox binary/auth setup are now deleted. This section records the migration's starting point rather than current behavior.

## Target responsibilities

### `FactoryWorkTicket`

The parent continues to own:

- Ticket state and Run recording;
- sandbox creation, repository clone and deletion;
- plan/implement/review sequencing and semantic turn budgets;
- pull request synchronization and exact-head CI observation;
- attempt recording before transcript persistence;
- final Ticket and Run outcomes.

For each agent-backed Step it starts a child, waits synchronously for the result, records the attempt and then persists the transcript by reference.

### `AgentWorkflow`

The child owns:

- input validation;
- a sandbox-affine Temporal Session for tool activities;
- prompt preparation through an activity;
- immutable conversation revisions;
- bounded model/tool iteration;
- provider/tool retry classification;
- cancellation of the active provider request or tool process;
- usage aggregation;
- structured final-output decoding;
- a durable transcript reference;
- `ContinueAsNew` before its own history approaches operational limits.

It does not open pull requests, inspect CI, mutate Ticket state or decide whether another factory Step should run.

## Public workflow interface

The public seam is one child workflow call and one result:

```go
type AgentWorkflowInput struct {
	Attempt     activities.StageAttempt
	ToolsetID   agent.ToolsetID
	Limits      agent.Limits
	CacheKey    string
}

type AgentWorkflowResult struct {
	Result          work.StageOutput
	Usage           work.Usage
	UsageMeasured   bool
	TranscriptRef   agent.TranscriptRef
	ModelTurns      int
	ToolCalls       int
}
```

`StageAttempt` remains bounded to the Ticket detail and `work.PriorTurns`; the parent never sends its complete accumulated history. The child turns that one input into an immutable conversation and thereafter carries references.

The workflow name is `AgentWorkflow`. A deterministic child workflow ID identifies the semantic Step:

```text
agent/<run-id>/<stage>/<turn>
```

The child has no workflow retry policy. Retry belongs to its activities; retrying the whole child would repeat already completed side effects. Duplicate child starts attach to the deterministic execution rather than create a second agent.

## Child lifecycle and cancellation

Every child is parent-owned and cancellable. The parent uses:

```go
workflow.ChildWorkflowOptions{
	WorkflowID:        id,
	ParentClosePolicy: enums.PARENT_CLOSE_POLICY_REQUEST_CANCEL,
	WaitForCancellation: true,
}
```

Abandon is wrong: an abandoned coding agent could continue modifying and pushing the ticket branch after the Run was cancelled or failed.

Cancellation propagates down both effect paths:

- cancelling a model activity cancels its HTTP request context;
- cancelling a tool activity cancels the local process through `exec.CommandContext`;
- the child completes its sandbox Session before returning cancellation;
- the parent retains its existing disconnected cleanup path and deletes the sandbox.

Temporal Session contexts do not cross workflow boundaries. The parent therefore stops creating the run-wide Session. Each child creates its own Session against `work.SandboxTaskQueue(runID)` and uses that Session context only for sandbox tool activities. Model, prompt and finalization activities remain on `work.TaskQueue`.

One sandbox worker serves one Session at a time. Children are synchronous and Steps are sequential, so this remains one active agent per ticket sandbox.

## Tool definitions: Go is the source of truth

There are no handwritten JSON tool-schema files.

A tool's Go input type simultaneously defines:

- the JSON Schema sent to the model;
- the strict runtime decoder;
- the handler's compile-time argument type;
- local validation metadata;
- generated documentation and schema fingerprints.

```go
type ExecCommandInput struct {
	Argv           []string `json:"argv" jsonschema:"minItems=1" jsonschema_description:"Command and arguments to execute without an implicit shell."`
	WorkingDir     string   `json:"working_dir" jsonschema_description:"Absolute directory under the ticket repository."`
	TimeoutSeconds int      `json:"timeout_seconds" jsonschema:"minimum=1,maximum=1800" jsonschema_description:"Maximum command runtime in seconds."`
}

var ExecCommand = agenttool.Define[ExecCommandInput](
	"exec_command",
	"Execute one argv command inside the ticket sandbox.",
)

var execCommand = agenttool.Bind(ExecCommand, executeCommand)
```

`Define[T]` reflects `T` once during worker startup using `invopop/jsonschema` with references disabled and additional properties forbidden. `Bind[T]` only accepts `func(context.Context, T) (agenttool.Result, error)`, so the schema type and handler type cannot drift.

The heterogeneous runtime catalogue uses a private erased interface. Callers never handle reflection or untyped argument maps.

```go
type runtimeTool interface {
	Specification() Specification
	Execute(context.Context, json.RawMessage) (Result, error)
}
```

Argument execution is strict:

1. validate raw arguments against the generated schema;
2. decode with `DisallowUnknownFields` and require EOF;
3. invoke `Validate() error` when the input type provides it for cross-field or filesystem rules;
4. call the typed handler.

Schema generation and compilation happen at startup, never on the tool-call path.

### Versioned toolsets

Toolsets are immutable and named:

```go
var CodingReadV1 = agenttool.MustSet(
	"coding-read-v1",
	readFile,
	execReadOnlyCommand,
)

var CodingWriteV1 = agenttool.MustSet(
	"coding-write-v1",
	readFile,
	execCommand,
	applyPatch,
)
```

Plan and review receive `coding-read-v1`; implement receives `coding-write-v1`. Read-only is a capability decision, not a sentence in a prompt. The read-only command handler rejects shells and mutating commands. The write handler still receives argv rather than a command string: no implicit shell is introduced, and a model that genuinely needs a shell must explicitly request an allowlisted shell argv.

`MustSet` fails worker startup on duplicate names, blank descriptions, missing property descriptions, unsupported strict-schema constructs, non-object inputs or non-deterministic ordering. It sorts specifications by name and records a stable schema fingerprint.

Changing an existing tool incompatibly creates `coding-read-v2` or `coding-write-v2`. A deployed `v1` meaning is never silently replaced while workflows can still reference it.

### V1 tools

`read_file`

- reads a bounded byte range from a repository-relative path;
- refuses traversal and paths outside the repository;
- returns content plus truncation metadata.

`exec_command`

- executes explicit argv with a bounded timeout and working directory;
- has separate read-only and write-capable handlers behind the same model-facing shape;
- captures bounded stdout/stderr and exit status;
- cancellation kills the process;
- oversized output is stored and returned by reference with a bounded preview.

`apply_patch`

- accepts one unified diff;
- applies it with `git apply` through stdin, never a shell;
- is available only in `coding-write-v1`;
- reports rejected hunks as a tool-visible failure.

Tool-visible failures such as invalid argv, a failed command or a rejected patch return `agenttool.Result{IsError: true}`. Infrastructure failures such as unavailable blob storage or an activity heartbeat failure return an activity error and use Temporal retry policy.

## Model interface

The provider seam remains deliberately narrow:

```go
type Turner interface {
	Turn(context.Context, codexresponses.TurnRequest, codexresponses.EmitFunc) (codexresponses.TurnResult, error)
}
```

The production adapter is the existing direct subscription-backed Responses client. `AgentWorkflow` and the tool catalogue do not know about OAuth headers, SSE framing or provider wire types.

The production model activity resolves the requested toolset, loads the conversation revision, calls the provider, stores the resulting response items and returns only durable routing metadata:

```go
type ModelTurnResult struct {
	Outcome         TurnOutcome
	ConversationRef ConversationRef
	FinalTextRef    TextRef
	ToolCalls       []PendingToolCall
	Usage           work.Usage
	UsageMeasured   bool
}

type PendingToolCall struct {
	CallID       string
	Name         string
	ArgumentsRef ArgumentsRef
}
```

Parallel tool calls are disabled in V1. Tool calls execute in provider order, producing a new conversation revision each time. This avoids concurrent revision writes and gives deterministic workflow ordering.

The direct client must preserve the provider's call ID and every output item needed for the next request. It continues using `store: false`; the factory, not the provider, owns durable conversation state.

## Prompt and final-output interface

Prompts remain product code under `internal/prompts`. Workflow code never imports that package.

The child's first main-queue activity receives `StageAttempt` and:

1. renders the stage instructions and user input;
2. resolves the stage's structured-output schema;
3. writes conversation revision zero;
4. starts the agent transcript;
5. returns `ConversationRef`, response-format identity and prompt cache key.

The finalization activity loads the final text, decodes it through the existing stage-specific prompt decoder and returns `work.StageOutput`. Model prose still cannot directly forge a GitHub identifier or decide CI state.

Existing output-schema files are prompt product artifacts, not tool definitions. They remain initially because they already have explicit agreement tests against the Go output shapes. Migrating them to reflected response types is a separate change and is not required to remove the CLI.

## Conversation and payload design

The workflow never carries the whole conversation after preparation.

```go
type ConversationRef struct {
	Key      string
	Revision int
	Bytes    int64
	Digest   string
}
```

Each revision is immutable and stored in the existing blob service under a new `conversations` bucket. Keys include the workflow identity, revision and content digest. `Put` is idempotent. Activities verify digest and expected predecessor before accepting a revision.

Arguments, large tool outputs, final text and transcripts are also immutable blobs referenced by small typed values. Temporal history contains refs, counts, names, IDs, usage and bounded error previews, not source files, command output or an ever-growing message slice.

The existing payload codec remains defense in depth for the initial child input and other ordinary payloads. It is not the conversation database and does not make quadratic history growth acceptable.

### Context budget and compaction

Limits are explicit workflow input fixed at child start:

```go
type Limits struct {
	MaxModelTurns       int
	MaxToolCalls        int
	MaxInputTokens      int64
	MaxOutputTokens     int64
	MaxConversationBytes int64
	ContinueAsNewAfter  int
}
```

Before each provider call the model activity estimates the next request. If it exceeds the configured context budget it compacts older tool chatter into a durable summary while retaining:

- system/developer instructions;
- the original stage request;
- the latest plan/implement/review handoff supplied by the parent;
- recent tool calls and outputs;
- every item required by the provider's call linkage rules.

Compaction writes a new immutable revision and a transcript event. It never mutates an existing conversation.

`AgentWorkflow` uses `ContinueAsNew` before its own event count becomes operationally large. Its continuation input is references plus remaining budgets and aggregate usage, not the conversation body. The synchronous parent follows the continued execution transparently.

## Transcript and observability

The old raw Codex CLI JSONL stream is replaced by a provider-neutral agent transcript. Events include:

- workflow prepared;
- model turn started/completed/failed;
- tool requested/completed/failed;
- compaction performed;
- final output decoded;
- cancellation and budget exhaustion.

Events carry IDs, names, durations, usage, exit status and bounded previews. They never carry OAuth credentials or unbounded reasoning deltas. The transcript is appended as immutable revisions and finalized to a `TranscriptRef`.

The parent preserves the database foreign-key ordering: record Attempt, then persist the transcript from its ref. No transcript bytes cross the child result.

Metrics distinguish:

- model turns and provider latency;
- tool calls by name and outcome;
- input/output tokens and measured/unknown usage;
- conversation bytes and compactions;
- turn/tool/context budget exhaustion;
- cancellation latency;
- activity retries and child outcome.

Logs include workflow/run/stage/turn/call IDs but no prompt, response, arguments or tool output content.

## Error model and idempotency

Closed failure classes replace string matching:

- invalid agent input or unknown toolset: non-retryable application error;
- unknown tool or schema-invalid arguments: tool-visible error returned to the model;
- command exit or patch rejection: tool-visible error;
- provider rate limit: classified application error used by the existing dispatcher breaker;
- transient provider/stream/blob failure: retryable activity error;
- model/tool/context budget exhausted: non-retryable typed child error;
- cancellation: Temporal cancellation, never rewritten as failure.

Provider retries need an idempotency key derived from workflow/run/stage/turn/model-turn. Conversation writes are content-addressed and idempotent. Tool activities use the provider call ID plus conversation revision as their operation identity. Retrying a completed tool call returns the already stored result instead of executing a side effect twice.

`exec_command` remains intrinsically capable of non-idempotent commands. The implementation records a completion marker before returning, and activity retries consult it. A worker death during the command, before a result is recorded, is an ambiguous execution and returns a typed unrecoverable attempt rather than blindly running the command again.

## Workflow compatibility and cutover

Replacing the three stage activities with child-workflow commands changes `FactoryWorkTicket` history and must be versioned at the exact stage-command seam:

```go
version := workflow.GetVersion(
	ctx,
	"factory-agent-workflow-v1",
	workflow.DefaultVersion,
	1,
)
```

Pre-change histories replay their recorded legacy commands. New histories start `AgentWorkflow`. The legacy activity result types and workflow branch remain long enough for replay, but the production registration and image no longer expose a path for a new CLI execution.

Cutover is operationally gated:

1. pause the factory dispatcher;
2. wait for or cancel every in-flight pre-version Run;
3. deploy the new worker and sandbox image;
4. prove workflow registration, tool registration and direct-provider credential validation;
5. start a canary Ticket through plan, implement and review;
6. restart the main worker during a model wait and the sandbox worker during a tool call;
7. confirm the same child execution completes with one attempt/result;
8. resume the dispatcher.

The sandbox image removes the Codex download, checksum, binary assertion and Codex home setup. The sandbox pod no longer mounts the Codex auth secret; the main worker alone reads and refreshes OAuth credentials for the direct model activity.

The isolated `agent-poc-*` commands and `agentpoc` packages are deleted after their behaviors are covered by production tests and the canary harness.

## Security

- OAuth credentials remain only in the main worker and its Kubernetes Secret client.
- No credential crosses a Temporal payload or reaches the sandbox.
- Tool paths are confined to the ticket repository after symlink-aware resolution.
- Tool argv is structured; no implicit shell interprets model text.
- Read-only toolsets enforce capability, not prompt intent.
- Tool output is bounded before it reaches logs, Temporal or the next model request.
- Existing sandbox pod security context and per-ticket isolation remain.
- Tool descriptions state side effects and return shapes explicitly.

## Rejected alternatives

### Depend on `Ingenimax/agent-sdk-go`

It usefully demonstrates a provider/tool/memory catalogue, but its public tool interface accepts JSON strings and separately maintained parameter maps. That permits the schema, decoder and handler to drift. Its in-process loop also cannot substitute for Temporal's durable ordering, cancellation and replay rules.

### Handwritten tool JSON or YAML

Rejected because it duplicates the Go input contract and eventually goes stale.

### Keep the whole conversation in workflow state

Rejected because every activity input/result is recorded in history. Resending an expanding slice creates quadratic bytes and reaches practical history limits well before Temporal's hard payload limit.

### Let the provider store the conversation

Rejected because `store: false`, auditable local retention, compaction and provider portability are product requirements. Provider response IDs may be recorded for correlation, not treated as the only durable state.

### Abandon children when the parent closes

Rejected because an agent could continue mutating and pushing after its business Run ended.

### Keep one parent-owned Temporal Session

Rejected because a Session context cannot be passed into a child workflow. Keeping it would force the agent loop back inline into the parent and lose the child-history isolation this design is intended to provide.

## Public test seams

Tests are written only at these agreed interfaces:

1. **Tool catalogue seam:** `Define`, `Bind`, `MustSet` and `Execute` prove generated schemas and typed execution without inspecting reflection internals.
2. **Agent workflow seam:** execute `AgentWorkflow` in Temporal's test environment with registered fake model/tool activities and assert durable outcomes, ordering, limits and cancellation.
3. **Tool activity seam:** execute the registered sandbox activity against a temporary repository through its public activity input/result.
4. **Stage integration seam:** execute `FactoryWorkTicket` with activity/child fakes and assert each semantic Step starts exactly one correctly configured `AgentWorkflow` child and consumes its typed result.
5. **Worker composition seam:** registration and image tests prove the production worker exposes `AgentWorkflow` and model activities, the sandbox exposes only tool activities, and no production artifact contains or invokes `codex exec`.
6. **Runtime acceptance seam:** a local Temporal/Kubernetes canary proves provider, worker restart, sandbox restart, cancellation and payload behavior end to end.

Tests do not mock private helpers, assert reflection calls or reach into workflow local state.

## TDD implementation plan

Each numbered slice is one red test followed by the smallest implementation that makes it green. Commit and push after every coherent green slice. Do not write all tests up front.

### Slice 1: typed tool definition

Write `TestDefineProducesStrictSchemaFromHandlerInput` with a known literal schema for a small input type. It must prove descriptions, required fields, constraints and `additionalProperties: false`. Implement `agenttool.Define[T]` and cached reflection.

Write `TestBindDecodesAndExecutesTheTypedInput` and `TestBindReturnsToolErrorForUnknownOrTrailingFields`. Implement strict decode, local schema validation and optional semantic `Validate`.

Write `TestMustSetRejectsDuplicateToolsAndSortsSpecifications`. Implement immutable versioned sets and stable fingerprints.

### Slice 2: immutable conversations

Write `TestConversationStoreAppendsAnImmutableRevision` against the in-memory blob adapter, using fixed literal keys/digests. Implement the `conversations` bucket, references, revision codec and append/load behavior.

Write `TestConversationStoreRejectsTheWrongPredecessorAndCorruptContent`. Implement predecessor and digest checks.

Write `TestLargeConversationCrossesTheWorkflowSeamAsASmallReference`. Encode the public workflow/activity values and assert the known large text is absent and the payload remains below the chosen warning threshold.

### Slice 3: production model turn

Write `TestModelTurnLoadsConversationAndStoresFinalText` with a fake `Turner` and in-memory conversation store. Implement preparation, model request construction, usage propagation and final-text storage.

Write `TestModelTurnStoresToolArgumentsAndPreservesCallIDs`. Implement function-call persistence and pending-call references.

Write `TestModelTurnHeartbeatsContentFreeProgressAndClassifiesProviderErrors`. Implement safe heartbeats and the closed provider error mapping.

### Slice 4: sandbox tools

Write `TestReadFileCannotEscapeTheRepositoryAndBoundsItsResult`; implement `read_file`.

Write `TestExecCommandUsesArgvCancelsTheProcessAndBoundsBothStreams`; implement `exec_command` on the existing local process adapter with completion markers.

Write `TestReadOnlyExecRejectsShellsAndMutatingCommands`; implement the read policy used by plan/review.

Write `TestApplyPatchChangesTheRepositoryAndReportsRejectedHunksAsToolErrors`; implement `git apply` through stdin.

Write `TestToolRetryReturnsTheRecordedResultWithoutExecutingTwice`; implement call-ID/revision idempotency.

### Slice 5: `AgentWorkflow`

Write `TestAgentWorkflowCompletesFromOneFinalModelTurn`; promote the POC's simplest behavior into production names and types.

Write `TestAgentWorkflowExecutesARequestedToolAndContinuesWithItsOutput`; implement the ordered model/tool loop using conversation refs.

Write `TestAgentWorkflowStopsAtModelToolAndTokenBudgets`; implement closed typed budget failures.

Write `TestAgentWorkflowRequestsCancellationOfTheActiveTool`; implement cancellable Session lifecycle and activity cancellation.

Write `TestAgentWorkflowContinuesAsNewWithOnlyReferences`; implement the history threshold and continued input.

### Slice 6: stage finalization

Write one test per plan/implement/review result proving the final activity decodes the existing structured output into the correct `work.StageOutput`. Implement prompt preparation and finalization around the existing renderer/decoder.

Write `TestAgentTranscriptPersistsAfterAttemptRecording` at the parent seam. Implement transcript refs and persistence-from-ref while preserving the database foreign-key ordering.

### Slice 7: parent integration and replay

Write `TestFactoryWorkTicketRunsPlanImplementAndReviewAsAgentChildren`. The test must assert deterministic child IDs, `REQUEST_CANCEL`, `WaitForCancellation`, stage-specific toolsets and typed results. Replace new-history stage activity calls with child calls.

Write `TestFactoryWorkTicketCancellationWaitsForTheAgentChildBeforeSandboxCleanup`. Implement cancellation ordering.

Export or construct a pre-change `FactoryWorkTicket` history and write `TestLegacyFactoryWorkTicketHistoryReplays`. Add `workflow.GetVersion` at the stage command seam and retain only the compatibility branch required for replay.

### Slice 8: composition and CLI removal

Write/modify registration tests first so they fail until:

- the main worker registers `AgentWorkflow`, prompt/model/finalize/transcript activities;
- the sandbox registers only the generic tool activity;
- no production worker registers `RunPlan`, `RunImplement` or `RunReview`.

Write an image/source acceptance test that fails while the production sandbox downloads, installs or invokes Codex. Then remove the Codex binary, CLI runner package, CLI argv/resume code, stage runner wiring, Codex-home setup and sandbox auth mount. Retain the direct OAuth and Responses packages.

Delete the isolated POC packages/commands after their production replacements are green.

Update `apps/software-factory/docs/system-map.md`, `images/README.md`, ADR-0011's superseding note, first-run/cancellation runbooks and observability documentation.

### Slice 9: focused and full verification

Run after each relevant slice:

```sh
cd apps/software-factory
go test ./internal/agenttool ./internal/agent ./internal/activities/... ./internal/workflows/...
```

Run before PR:

```sh
cd apps/software-factory
go test ./...
go test -race ./...
golangci-lint run
```

Build the worker and sandbox images and run their smoke assertions. Confirm `rg -n 'codex exec|/usr/local/bin/codex|CODEX_VERSION'` finds no production code/image path; historical ADR text may remain only with an explicit superseded annotation.

### Slice 10: local runtime acceptance

Start the real worker and sandbox in the local Kubernetes cluster against local Temporal. Run one fixture Ticket that requires at least one read, command and patch before returning a valid implement result.

Capture evidence that:

- Temporal UI shows `FactoryWorkTicket -> AgentWorkflow`;
- the child has its own bounded history;
- tool activities run on the sandbox Session queue;
- no Temporal payload contains the full large conversation;
- restarting the main worker during a delayed model activity completes the same child;
- restarting the sandbox worker during a delayed tool activity completes or returns the defined ambiguous-execution failure without duplicate mutation;
- cancelling the parent cancels the child and active tool before sandbox deletion;
- transcript and usage appear in the Run record.

### Slice 11: production cutover

Open the PR and wait for every required check. Before merge, pause the production dispatcher and establish that no pre-version Run remains in flight. Merge only when CI is green.

After deploy, run a canary Ticket, inspect Temporal/Grafana/Postgres evidence, then resume the dispatcher. If the canary fails, keep the dispatcher paused and fix forward through the branch/PR workflow; do not restore `codex exec` as an unversioned fallback.

## Definition of done

- Every new plan, implement and review Step runs through `AgentWorkflow`.
- The sandbox image does not contain the Codex CLI and production code cannot invoke `codex exec`.
- Tool schemas, strict decoders and handler input types have one Go source of truth.
- Plan/review receive enforced read-only capabilities; implement receives the versioned write toolset.
- Conversation growth is reference-backed, budgeted and compactable rather than repeated through Temporal payloads.
- Parent cancellation waits for child/tool cancellation before sandbox deletion.
- Old workflow history replays through the version marker.
- Focused tests, full tests, race tests, lint and image builds pass.
- Local restart/cancellation/payload acceptance evidence is captured.
- The green PR is merged and the production canary completes before the dispatcher resumes.
