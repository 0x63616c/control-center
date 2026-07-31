# The software factory owns its tickets, its record, and its console

The factory stops being a GitHub-Issues-driven script whose only human-readable output is a
comment thread. It gains its own **Tickets** in its own Postgres database, its own HTTP API,
and its own web console. GitHub keeps what GitHub is good at — code, pull requests, CI,
review, and merge-deploys-prod — and stops being the factory's work queue, its state store,
and its progress log.

Three questions have no answer today, and every one of them is an Operability question in the
sense `apps/software-factory/docs/SoftwareStyle.md` uses the word:

- **What is in flight?** Answerable only by opening Temporal's UI, or by scrolling issues
  looking for a recent status comment.
- **What is it going to work on next?** Not answerable anywhere. The dispatcher computes
  candidates every 30s and persists that decision nowhere.
- **What has it worked on, what did each step cost, how many times did it run, and what did
  it actually say?** Partially answerable, one issue at a time, by a human reading prose.

SoftwareStyle already states the standard this fails: *"Operability > Economy. Decision logs,
transcripts and token accounting cost something. Pay them — you cannot run an unattended
code-shipping system you can't watch."* Its 3am test is *"can you tell which ticket is on
which stage, why it decided what it did, and stop it without leaving a half-pushed branch?"*
That test is the console's acceptance criterion, and it is quoted here rather than restated
because it is already the house standard.

## How to read this if you are implementing one ticket from it

This document is the design authority for the work it describes. Individual tickets carry
task-specific detail; where a ticket and this ADR disagree about a *decision*, this ADR wins
and the ticket is wrong. Where this ADR and the **code** disagree about what exists *today*,
the code wins — `apps/software-factory/docs/system-map.md` is the report on the code, and it
is itself known to be behind (#526).

Everything in *Deliberately not decided* below is out of scope. Do not invent an answer there;
raise it on the issue instead.

## Vocabulary

One word per concept, used consistently everywhere from here on.

| term | meaning |
|---|---|
| **Ticket** | A unit of work in *our* store. Ours, not GitHub's. |
| **Issue** | A GitHub issue. A different thing, in a different system. |
| **Run** | One attempt at a whole Ticket. One Temporal workflow execution. |
| **Stage** | A *kind* of work: `plan`, `implement`, `review`. |
| **Step** | One instance of a Stage inside a Run, identified by its turn number. |
| **Attempt** | One execution of a Step. |
| **Console** | The web UI. |
| **Relay** | The webhook fan-out service. |

"Ticket" and "Issue" are never used interchangeably. Renaming is half the point: the factory's
unit of work is no longer a GitHub object, and continuing to call it an issue would keep
inviting the assumption that it is.

## Tickets replace Issues, for the factory only

The factory's work queue, state, and progress record move to our Postgres. GitHub Issues
remains a personal tracker for human work; it simply stops feeding the factory.

This is a full replacement **within the factory's scope**, not a mirror. Nothing dual-writes.
There is no sync, no import, no promotion path, and no bridge in v0 — a Ticket is created
directly through our API and has no GitHub Issue behind it. That eliminates the failure mode
this design most needed to avoid: two stores each believing they hold the truth about one
piece of work.

Moving existing `auto` issues into the new system is **out of scope entirely** and is being
handled separately by hand. Assume the new system starts empty.

There is deliberately **no `source` column** on Ticket. If a second origin ever exists, adding
the column and backfilling every existing row to the then-current value is a trivial
migration. That reasoning does *not* extend to per-attempt model and effort — see below —
because those cannot be reconstructed after the fact.

## The entity model

Four levels. Each is a row.

```
Ticket ─┬─ Run ─┬─ Step ─┬─ Attempt
        │       │        └─ Attempt
        │       └─ Step ─── Attempt
        └─ Run …
```

| entity | identified by | notes |
|---|---|---|
| Ticket | our own minted id | The unit you file and read. |
| Run | Temporal run id | One pass at the Ticket. A Ticket may have several over its life. |
| Step | `(run, stage, turn)` | Exactly today's `work.StageKey`. |
| Attempt | `(run, stage, turn, attempt_no)` | One execution of that Step. |

`work.StageKey` already carries `{Ticket, RunID, Stage, Turn}` and already documents `Turn` as
*"which attempt of Stage this is within RunID, starting at 1"*. The row keys are that struct,
not a new scheme.

### Why Attempt is a row and not a counter

Because "how many times did it run that step?" has **three** distinct answers today, and
collapsing them makes the console lie:

1. **Turns** — semantic re-work. `internal/workflows/loop.go` counts `implementTurn` across
   the whole run, 1-indexed, never reset per window. The model was asked to do the work again
   because CI was red or review found something. Tokens were spent. This is the interesting
   number.
2. **Attempts within a Step** — the Step ran again for a machine reason: the sandbox pod died
   (`workflow.ErrSessionFailed`), a heartbeat timeout, a Codex crash, or the stage timeout.
   Tokens may have been spent with nothing to show for them.
3. **A resumed Step** — an activity retry found a completed `result.json` on disk and returned
   it **without running Codex at all**. Zero tokens.

Case 3 is why `measured` must live on the Attempt. Today a resumed stage reports `Usage` zero
with `UsageMeasured: false`, **nothing reads `UsageMeasured`**, and the rendered output is
indistinguishable from a real measurement — so a run's totals silently under-report by a whole
stage. That is #426. Building token accounting on top of that data without carrying `measured`
through would reproduce the same lie in a nicer font.

A counter on Step has nowhere to put `measured`, and nowhere to put the tokens an attempt
burned before dying.

### What an Attempt row must carry

Load-bearing, decided here:

- `model` and `effort` — **on the Attempt, not the Run.** Per-stage model overrides already
  exist as config (`Config.ModelFor`), so two Steps in one Run can legitimately use different
  models, and that is expected to become more common. A Run-level column would destroy the
  distinction irreversibly.
- The four token counts already modelled by `work.Usage`: `InputTokens` (which *includes*
  `CachedInputTokens`), `CachedInputTokens`, `OutputTokens` (which *includes*
  `ReasoningTokens`), and `ReasoningTokens`. The inclusion relationships are documented on
  that type and must not be re-derived or silently re-based.
- `measured` — whether Codex actually ran.
- Start and end timestamps, and how the attempt ended.

Exact DDL, column naming and index choices are the implementing ticket's business. The above
is the part that is expensive to get wrong.

### No costs in v0

v0 stores **token usage only**. No price table, no `cost_usd` column, no currency anywhere in
the API or the console. A dollar-costing feature is expected later and is explicitly deferred.

Storing `model` and `effort` per Attempt is what makes that later feature possible *and
retroactive*: prices change, token counts do not, so a price table added later can compute
historical spend correctly. Without the model on the row, it never can.

### What the console shows for a Step

`implement · turn 3 of 15 · 47m` — the turn is the headline. `· 2 attempts` appears only when
there was more than one, so a healthy run reads quietly and an unhealthy one is loud. An
Attempt with `measured = false` renders its usage as **unknown**, never as zero.

## Ticket states

Five. No more.

| state | meaning |
|---|---|
| `open` | Filed, not started. |
| `working` | A Run is in flight. |
| `review` | A Run produced a pull request; waiting on a human. |
| `done` | Terminal. **Satisfies dependencies.** |
| `failed` | Terminal. **Does not satisfy dependencies.** |

- **`done` requires the pull request to be merged**, not merely opened. Merging is what
  deploys; a downstream Ticket built on unmerged code is built on nothing.
- **`failed` never auto-retries.** A human moves it back to `open`. Automatic retry of a
  failing Ticket burns quota in a loop, which is the same reason the machine already clears
  `auto` on a hard failure today rather than letting the dispatcher relist it forever.

## Dependencies: edges are stored, blocking is derived

Tickets form a dependency graph. One relation only — `blocks` / `blocked_by`, read in both
directions. No `relates_to`, no `duplicates`, no parent/child hierarchy: those are a different
axis and are deferred until something needs them.

**`blocked` is never a stored state.** It is computed:

```
ready(T)  ⟺  T is `open`  ∧  every Ticket T depends on is `done`
```

This is the whole answer to the propagation problem. An upstream Ticket that fails is not
`done`, so everything downstream is not `ready` — with no cascade job, no stale flags, and no
"why is this still marked blocked". An edge added mid-flight takes effect on the next read. A
reopened upstream un-readies its downstream automatically.

The graph is tens to hundreds of nodes; a recursive CTE answers this trivially. The one thing
that must actually be enforced on write is **cycle rejection** — adding an edge that would
create a cycle is a client error, not a stored inconsistency.

The dispatcher selects only `ready` Tickets. Nothing else changes about how it claims them.

### Before the new store exists

Dependency-ordered work is needed *now*, to build this system with this system. That is #528,
which is deliberately built on GitHub's native issue dependencies rather than on anything
invented: the issue-list response already carries an `issue_dependencies_summary`, whose
`blocked_by` field counts **open** blockers only (`total_blocked_by` counts all of them). So
the interim rule is `blocked_by == 0`, costs no extra API request, and self-clears when a
merge closes the upstream issue. It is the same semantics this ADR specifies, applied to the
system we are replacing.

## Postgres is the queryable projection; Temporal remains the durable record

A new CloudNativePG cluster for the factory. The operator is already installed
(`infra/src/cnpg.ts`) and already runs product-owned single-instance clusters for
control-center, home-assistant and temporal; this is a fourth, declared the same way.

**Why a database at all, when Temporal keeps ten years of history:** Temporal answers
questions about *one* workflow. Cross-run questions — what ran this week, what did it cost,
which stage fails most — are not queries there; they are hundreds of point lookups and a lot
of payload decoding. The dispatcher already pays that cost per in-flight ticket
(`DescribeWorkflowExecution`, deliberately a point lookup rather than a visibility search).
And once Tickets are ours, the tables have to exist anyway.

**The UI and the API never read Temporal for state.** If something needs to be visible, the
workflow writes it to Postgres and the console reads Postgres. There is no path where a page
load fans out into orchestration-plane queries.

### The write path

Activities write to Postgres as the Run happens — the same seam, and the same places in the
workflow, where the code currently posts and edits GitHub status comments. There is
**no exporter** that tails Temporal histories and projects them after the fact: it would be
eventually consistent, so an in-flight Run would be invisible or stale, and "what's in
flight" is the first question this whole design exists to answer.

Recording is therefore a Temporal **activity**, with everything that implies: it retries under
a policy, and a database outage lasting longer than that policy **stalls the Run at that
activity and then fails it, loudly**. That is the correct behaviour, and it follows from
SoftwareStyle's ordering — *Correctness > Operability* means halt rather than limp, and a Run
whose progress is not recorded is a Run nobody can watch. It is *not* fire-and-forget, and it
is not best-effort.

Row keys are `work.StageKey`, so a replay or repair path could later upsert rather than
duplicate. Building that path is not part of this work.

## Transcripts move into Postgres

Today a stage's raw JSONL event stream is written to the sandbox pod's **local** disk, carried
home as a field on the stage's output through a Temporal payload, and written to NFS by the
`PersistTranscript` activity on the main task queue. The NFS volume is mounted on the worker
only; nothing else can read it, and no browser can reach it.

Two facts make the move cheap and safe, both read out of `internal/work/transcript.go`:

- **A transcript is per Attempt, not per Run**, and **the largest measured on disk was 292
  KiB** — about 57% of Temporal's 512 KiB payload warn threshold. That measurement is why
  nothing else may be added to that payload and why one transcript is carried per call.
- `PersistTranscript` is already the single durable-write chokepoint. Pointing it at the
  database instead of the NFS sink is a change at an existing seam, not new plumbing: no
  sandbox credentials, no second mount, no new trust boundary.

Stored compressed, one row per Attempt, downloadable through the API. **Kept forever** — a
heavy year is single-digit megabytes, and the house preference is to keep data until its
volume argues otherwise rather than to design retention against a guess.

The NFS transcript PersistentVolume is retired as a consequence, which removes one of the
consumers of the PV that is provisioned against the whole NAS export (#412).

**Live transcript tailing is deferred.** A transcript lands durably only when its stage
completes, so tailing is real work — a persistence change, not a UI toggle — and it is
expected to be wanted later.

## The API

**Go, using huma, in the existing `apps/software-factory` Go module, as `cmd/api`.** One
module, one set of libraries, one linter config, one set of standards; that module already
produces several binaries. Shared domain types (`work.StageKey`, `work.Usage`,
`work.Outcome`) have exactly one definition serving both the worker and the API, which is
SoftwareStyle tenet 12 applied rather than restated.

**Code-first, not spec-first.** Go structs and handlers are the source of truth; huma emits
OpenAPI 3.1 from them, so the spec cannot drift from the handlers that serve the requests.
huma serves `/openapi.json`, `/openapi.yaml`, and — for tooling that lags 3.1 —
`/openapi-3.0.json` and `/openapi-3.0.yaml`, plus `/docs` and `/schemas`.

Spec-first (`ogen` and friends) was considered and rejected: it pays off when several teams
negotiate a contract across repositories, and the drift this system is actually exposed to is
"spec says one thing, handler does another", which code-first makes structurally impossible.

### Generated artefacts are checked in

huma has no built-in spec-dump command; a Cobra subcommand on the CLI root that prints
`api.OpenAPI().YAML()` (or `.DowngradeYAML()` for 3.0.3) produces the spec without starting a
server.

The pipeline mirrors ADR-0002's committed-codegen rule exactly:

1. The spec is generated to a **checked-in file**.
2. **Orval** reads that file and generates the console's TypeScript client — types plus
   `@tanstack/react-query` hooks, which is the tRPC-like ergonomics the rest of this repo has,
   without tRPC. Also checked in.
3. One command regenerates both; a second re-runs it and **fails on drift**, and CI runs that.
4. Generated output is never hand-edited.

If Orval trips on OpenAPI 3.1, point it at a generated 3.0.3 file instead. Do not emit both
until that actually happens.

tRPC was rejected outright: it has no usable OpenAPI output, and a self-describing contract for
agents is a hard requirement. A TypeScript API (Hono + zod-openapi) was rejected because it
would put the factory's database under two runtimes with two migration stories. Connect/protobuf
was rejected because agents would get a `.proto` rather than an OpenAPI document.

### Agents calling the API

OpenAPI alone does not stop an agent from getting an endpoint wrong — it still hand-writes
requests. The spec is the *input* to the things that fix that: a generated CLI, or an MCP
server whose tool schemas make a malformed body unrepresentable. Both are **deferred**; the
spec existing is what makes them cheap later.

## Control: the API speaks Temporal, the console never does

Reads come from Postgres. Commands — pause the factory, cancel a Run, change max-in-flight,
start work on a Ticket now — are Temporal signals, sent **by the API**.

- The console never holds a Temporal client and never reaches the orchestration plane. This is
  not stylistic: the cluster's Temporal has no TLS and no authentication (#442), so
  reachability from a browser-facing surface would be equivalent to full orchestration-plane
  access.
- The API is Go, in the same module and namespace as the worker, so it can hold a Temporal
  client without crossing a boundary that did not already exist.
- The dispatcher's `GetStatus` **query** is retired. Instead the dispatcher writes its own
  state to Postgres on each tick. That is also what finally makes *"what is it going to work
  on next"* answerable: the candidate set is a decision the dispatcher makes every 30s and
  currently persists nowhere.

A command-row table polled by the dispatcher was rejected: it re-invents queueing next to a
queue and makes "pause now" laggy and dishonest.

## Exposure and authentication

### One hostname, same origin

`factory.worldwidewebb.co` serves the console at `/` and proxies `/api/*` to the API's
in-cluster Service. This is the pattern `apps/web` already uses, where nginx proxies `/trpc`
to `http://api:4201` and the SPA and its API are same-origin behind one hostname.

Consequences, all deliberate: no CORS, one Access application covering both the UI and the
API, one DNS record, one TLS name. **There is no `api.worldwidewebb.co`** — control-center's
API is `internalService` today and has no public hostname, and this does not add one.

Hostnames must be a **single label** under the zone so Universal SSL's one-label wildcard
covers them; `factory` and `factory-hooks` both satisfy that. Public hostnames are owned in
one place, `controlCenterProductManifest()`, and these are declared there like every other.

The Service is named **`api`** in the `software-factory` namespace — namespaces scope names,
cluster DNS disambiguates (`api.software-factory.svc.cluster.local`), and it mirrors
control-center's existing `api`/`worker` pair.

### Who may call it

Three classes of caller, one rule: **the API authenticates every request regardless of where
it came from.** In-cluster traffic is not trusted merely for being in-cluster.

| caller | how it authenticates | stored where |
|---|---|---|
| A human in a browser | Cloudflare Access email-OTP, same as Grafana/pgAdmin/Temporal UI | nothing stored |
| An agent or CLI outside the cluster | Cloudflare Access **service token** | Cloudflare mints it; the pair goes to SOPS |
| The worker (in-cluster) | static bearer, **write** scope | SOPS → Kubernetes Secret |
| A sandbox (in-cluster) | static bearer, **read-only** scope | SOPS → Kubernetes Secret, mounted per run |

Access authenticates at the edge and passes a signed JWT to the origin on the
`Cf-Access-Jwt-Assertion` request header (Cloudflare's own guidance is to validate that header
rather than the `CF_Authorization` cookie, which is not guaranteed to be passed). Validation is
the standard sequence: fetch the team's keys from
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` **dynamically, never hardcoded**,
because they rotate; match `kid`; verify the signature; confirm `iss` is our team domain and
`aud` matches this application. `aud` is per-application, which is what stops a JWT minted for
another Access app being replayed here.

Two Access details that break things silently if missed:

- The policy for programmatic callers must use the **Service Auth** action. Without it, Access
  prompts for an identity-provider login and the agent receives HTML instead of JSON.
- An application with *only* Service Auth policies requires the token on every request; the
  JWT can only be relied on when the application also has at least one Allow policy. This one
  has both.

So we write no login page, store no passwords, run no session store, and issue no tokens. What
we do write: JWT verification for external callers, a constant-time bearer comparison for
in-cluster callers, and an identity→scope map.

**A sandbox's token is read-only.** An agent working a Ticket must not be able to mark that
Ticket `done` — the same principle that already makes the workflow ask GitHub whether a pull
request exists rather than believing what a stage claimed.

A database-backed token table is **not** built initially. There are three identities; static
secrets cover them, and a token table is a later migration rather than a redesign.

## Webhooks: one entry point that fans out

`hooks.worldwidewebb.co` becomes a **relay** that verifies each delivery once and forwards it,
independently, to every configured consumer.

The constraint that forces this shape: `hooks.worldwidewebb.co` is fed by the **same GitHub App
the factory uses**, and a GitHub App has exactly one webhook URL. A second endpoint is
therefore not available, and the relay must sit in front.

Decided:

- **Replace, not add.** Same hostname, same DNS record, same TLS name, same App webhook
  configuration, same `publicWeb` manifest entry. Only the tunnel *origin* changes, from
  control-center's `api` Service to the relay's.
- **The relay verifies the HMAC.** It is the auth boundary for inbound deliveries.
- **The relay is stateless.** No database, no volume, no queue. Three attempts per target,
  then log, count, and drop; recovery is GitHub's *Redeliver* button, which is safe because
  consumers are already idempotent on the delivery id.
- **Targets fail independently.** One target being down, slow or erroring must have no effect
  on any other. This ruled out Redpanda Connect / Benthos `broker` + `fan_out`, whose
  documented behaviour is that one output applying back pressure blocks all subsequent
  messages, and nginx `mirror`, which is fire-and-forget with no retries and an asymmetric
  primary.
- **Go, in the existing factory module, as `cmd/relay`** — one Go tree, one set of libraries
  and standards. Code location is not service ownership: the relay is a platform service with
  its own namespace, Deployment, image and lifecycle, and it must not import the factory's
  domain packages.
- **It ships with exactly one target, control-center**, which makes the cutover
  behaviour-preserving and verifiable. The factory consumer is a later configuration line.
- **`features/hooks/` is not modified.** It keeps its code, its path, its own HMAC
  verification and its `incoming_webhook` table; it simply stops being internet-reachable.

Kept rather than deleted, even though **nothing in the repository reads `incoming_webhook`
today** — the only references are the schema and one insert — because it is the sole verbatim
archive of every delivery, and because the relay needs a target to be testable. (Its manifest
also claims a retention purge in a `jobs.ts` that does not exist. Neither fact is fixed here.)

**What the relay buys:** `pull_request.closed` with `merged: true` marks a Ticket `done`,
which makes every downstream Ticket `ready` on the dispatcher's next tick. That single event
is the dependency engine. Without it, PR state must be polled for every open Ticket forever.

### The in-cluster trust caveat

The factory's own consumer keeps its own HMAC verification **until the sandbox network hole is
closed** (#532), then drops it. Today the cluster's CNI implements no policy engine and there
are zero NetworkPolicies, so any pod — including a sandbox running a model against
attacker-influenceable issue text — can POST directly at an internal consumer. That is a
defect being fixed on its own terms, not a constraint this design should be bent around; the
duplicate verification is a stopgap with an explicit end date, not a permanent belt.

## Live updates: polling

The console polls. Runs last hours; three-second granularity is invisible, and polling is the
mechanism that cannot break — no long-lived connections through the tunnel, no reconnect
logic, no server-side subscription state.

Server-sent events were considered and deferred to the one place they will actually earn
their keep, live transcript tailing, which is deferred for its own reasons (transcripts only
land durably at stage end).

## Cutover

The claim scheme changes. `work/paths.go` states the consequence plainly: *"changing the
scheme once runs are in flight would orphan open workflows and let their tickets be claimed
twice, so that change costs a drain rather than a deploy."* Today's workflow ID is built from
the GitHub issue number; Ticket ids are ours.

So: pause the dispatcher, let the in-flight Runs finish (the cap is 2), deploy, unpause. The
workflow ID stays self-describing by construction, keyed on the Ticket id instead.

Dual-reading both GitHub `auto` issues and Tickets during a transition was rejected: two claim
schemes live at once, two places to look when something is not picked up, and a second system
to build, test and then delete.

**The factory stops posting to GitHub entirely.** No pickup comment, no per-step comment, no
outcome comment. Progress lives in the database and the console, and `internal/status/`'s
comment rendering stops being called for progress. The only GitHub write left in the pipeline
is the pull request itself, whose body links back to its Ticket in the console.

The cost, stated so it is not discovered later: the issue thread is currently a
phone-readable audit trail requiring no VPN. After cutover there is no such trail, and this is
accepted — a mobile capture and reading path is explicitly not being built (see below).

## Repository layout

| what | where | governed by |
|---|---|---|
| Worker, dispatcher, activities | `apps/software-factory/` (unchanged) | `SoftwareStyle.md`, `.golangci.yml` |
| API | `apps/software-factory/cmd/api` | same |
| Relay | `apps/software-factory/cmd/relay` | same |
| Console | `apps/software-factory/web/` | `docs/writing-scalable-typescript/` |

One product directory, one Go module, two languages.
`apps/software-factory/AGENTS.md` needs one line recording that SoftwareStyle governs the Go
and the TypeScript guide governs `web/`, because SoftwareStyle's own scope line says it
governs that directory and a TypeScript SPA under a Go style guide is otherwise ambiguous.

## What this changes in SoftwareStyle

Two clauses in `apps/software-factory/docs/SoftwareStyle.md` become false and must be updated
as part of this work rather than left to rot:

1. **Identity.** It currently says *"Do not mint IDs. GitHub issue numbers and Temporal
   workflow and run IDs already exist and are already authoritative… Add a generator seam only
   if something needs an identity Temporal does not already give it."* Tickets are exactly
   that case. Workflow IDs stay self-describing by construction, now derived from the Ticket
   id.
2. **Operability.** It lists *"the status comment on the issue"* among the mechanisms that
   make the system watchable. That mechanism is being deleted; the console replaces it.

## Deliberately not decided

Do not invent answers to these while implementing. Raise them.

- **Dollar costs.** v0 stores tokens only. A price table, per-model rates, cached-input rates
  and any currency display are a later feature.
- **Live transcript tailing**, and the better transcript persistence it needs.
- **A mobile capture path.** No progressive web app, no phone-optimised create form, no
  shortcut integration. The console is used on a laptop. Revisit only if it becomes a real
  problem.
- **Importing existing GitHub Issues.** Handled by hand, separately.
- **A GitHub Issue → Ticket bridge of any kind**, including label-triggered promotion.
- **Additional relationship types** — `relates_to`, `duplicates`, parent/child hierarchy.
- **A generated CLI or MCP server** over the API.
- **A token table** with per-caller revocation and scoping.
- **Which JWT claim identifies a specific Cloudflare service token.** This was not confirmed
  from documentation and must be determined empirically if per-agent identity is ever needed;
  today the distinction that matters is human-versus-machine and scope, not which machine.
- **A backfill or repair path** that rebuilds Postgres from Temporal history.
- **Object storage.** There is none in this cluster, and adding one to store small compressed
  blobs a few times a day was rejected.

## Rejected, with reasons

| rejected | why |
|---|---|
| Keeping GitHub Issues as the factory's store | The observability gap is structural; the thread is prose, one issue at a time, and cross-run questions have no answer. |
| A factory-only store with GitHub Issues still authoritative for some factory work | Two stores claiming truth about one piece of work. The rot this design exists to avoid. |
| Mirroring a promoted Issue instead of owning the Ticket | A sync problem, and sync problems are how you stop knowing what is in flight. |
| An exporter that projects Temporal history into Postgres | Eventually consistent; in-flight Runs invisible or stale. |
| Reading Temporal from the UI or the API for *state* | Point lookups do not answer cross-run questions, and Temporal has no TLS or authn (#442). |
| Storing a `blocked` flag | Cascade jobs and stale flags. Deriving from edges makes upstream failure, reopening and mid-flight edits correct for free. |
| Three-level entity model (Attempt as a counter) | Nowhere honest to put `measured`, nowhere to put tokens an aborted attempt burned. |
| Transcripts left on NFS with a pointer in Postgres | The API would need the NFS mount, widening exposure to a PV provisioned against the whole NAS export (#412). |
| Object storage (MinIO or similar) for transcripts | A new stateful dependency for tens of kilobytes a day. |
| Exploding transcript events into rows | Millions of rows for a query nobody has asked for; the raw stream is still needed for download. Derivable later if wanted. |
| tRPC | No usable OpenAPI output. |
| A TypeScript API | Two runtimes owning one schema, two migration stories. |
| Connect/protobuf | Agents get a `.proto`, not an OpenAPI document. |
| Spec-first Go (`ogen`) | Solves cross-team contract negotiation we do not have; code-first eliminates the drift we do have. |
| A separate `api.worldwidewebb.co` | A second hostname, a second Access app, and CORS, to solve nothing. |
| Trusting in-cluster traffic without authentication | The assumption that made the sandbox network hole dangerous. |
| A fan-out proxy built on Benthos/Redpanda Connect | `fan_out` back pressure blocks all subsequent messages — the exact failure mode being designed against. |
| nginx `mirror` | Fire-and-forget, no retries, asymmetric primary. |
| A second GitHub App for inbound events | A second identity to create, install and rotate, when a relay in front of the one App suffices. |
| Having the factory read control-center's webhook table | Crosses the isolation boundary the factory's own namespace exists to enforce. |
| Server-sent events or WebSockets in v0 | Polling cannot break; SSE earns its keep only for live tailing, which is deferred. |
| Dual-reading GitHub and Tickets during cutover | Two claim schemes live at once; a second system to build and delete. |
| Keeping a summary comment on GitHub after cutover | Data stays ours; a partial trail in a system we no longer treat as authoritative invites reading it as one. |
