# Control Center

The domain of the wall-mounted home control panel: a fixed-size touch surface showing a
world of tiles, backed by a tRPC API and interval/queue workers that reconcile the physical
home. This glossary fixes the ubiquitous language. Terms marked _(target)_ name a concept the
team intends to build; they do not exist in the code yet and are recorded here so design
conversations stay precise.

## The device and its surface

**Panel**:
The physical wall-mounted touch device. A single fixed, non-responsive `1366x1024` surface;
there is one per home.
_Avoid_: screen, kiosk, display, tablet.

**Board**:
The single pannable world that fills the Panel and hosts every Tile, plus the always-on
Chrome. Panning is frozen whenever an Overlay is open.
_Avoid_: canvas, grid, desktop, home screen.

**Chrome**:
The always-on, board-level surfaces that belong to no single Tile — status banners and update
prompts drawn directly on the Board rather than through a Tile.
_Avoid_: HUD, shell, overlay (an Overlay is a different thing — see below).

**Banner**:
One piece of Chrome: a persistent notice strip on the Board (e.g. device-name, connection-lost,
update-available, unplaced-tiles, not-charging). A Banner is not a Tile and has no detail view.
_Avoid_: toast, alert, notification (a Notification is a queued user message — different).

## Tiles and their detail surfaces

**Tile**:
A rectangular feature card placed on the Board — the atomic unit of the interface. Each Tile
has a stable id, a compact card face, and (usually) a detail surface reached by tapping it.
_Avoid_: widget, card, block, panel (Panel is the device).

**Home tile**:
The one Tile the Board recenters on when it returns to rest (the clock). There is exactly one.
_Avoid_: default tile, start tile.

**Placement**:
Where a Tile sits in the Board's coordinate space — its world column/row and its column/row
span. Placement has a per-Tile default and an optional persisted override; a Tile with neither
a default nor an override slot is unplaced.
_Avoid_: position, layout, coordinates.

**Tile View**:
The concept of a Tile's detail surface — what opens when a Tile is tapped. Today a Tile View is
realised as either a Modal or (for the migrated Tiles) a Page; the term is agnostic to which.
_Avoid_: detail, expanded view, drilldown.

**Overlay**:
Any surface that covers the Board, is anchored to fill it, and freezes Board panning while open
(Modals, Pages, the PIN gate, and full-screen tools all are Overlays). The umbrella term.
_Avoid_: dialog, popup, sheet.

**Modal**:
The legacy form of Tile View: a dialog-style Overlay, one of which may offer several **Variants**
switchable in place (e.g. three ways to read the same Tile's data). The pattern being migrated
away from.
_Avoid_: popup, dialog.

**Variant**:
One of several interchangeable renderings of a single Modal's Tile View, chosen by a switcher.
Peculiar to the Modal form; a Page has no Variants.
_Avoid_: mode, tab, view (Tile View is the whole surface).

**Page** _(partly built)_:
The target form of Tile View: a single full-screen Overlay that replaces the multi-Variant
Modal — one scrolling surface with a back affordance, Escape-to-close, and idle-dismiss. Settings
and Activity already take this form; the rest are to follow.
_Avoid_: full-page modal, screen, route.

## Grouping (target vocabulary)

**Product**:
A deployable top-level unit of the repo: its own services, image builds, database, and namespace.
There is one Product, control-center (see ADR-0006 — captive-portal dissolved into it); the term
is retained for the deploy unit itself, not as a claim that more than one exists today. Described
by a **Product Manifest**. Must not be confused with App / App Manifest below.
_Avoid_: app (an App is smaller — see below), service, package.

**App** _(target)_:
A single self-contained feature grouped as one unit — its Tile(s), the API slice that backs them,
the Worker Cycles and Queue Jobs it needs, and the tables it owns — living together in one folder
inside a Product. The consolidation the re-architecture aims at; today these pieces are scattered
and tied together only by convention. `guest-wifi` (the former captive-portal product, folded per
ADR-0006) is the canonical example: one folder holding the portal-only listener, the guest static
bundle, and its owned tables.
_Avoid_: feature, module (reserved for design vocabulary), plugin, product.

**App Manifest** _(target)_:
The single declaration that ties an App's parts together (its Tiles, router slice, jobs, tables,
and flags such as Sensitive), replacing today's implicit wiring across the registry, router
object, and worker array. Distinct from the deploy-time Product Manifest.
_Avoid_: manifest (ambiguous — always qualify as App or Product), config, registration.

## Security and access

**Sensitive** _(target)_:
An App-level flag marking a feature whose Tile View may only be opened after Unlock. Today no such
flag exists; PIN gating is hand-wired per feature.
_Avoid_: private, protected, locked, secure.

**PIN**:
The numeric passcode (six digits) that guards Sensitive features. Stored as a synced setting and,
today, compared entirely on the client; no server-side check exists.
_Avoid_: password, passcode, code.

**Unlock** / **PIN Session**:
The state of having entered the correct PIN so a Sensitive Tile View will open. Today there is no
single shared session — each guarded feature runs its own independent gate; a shared PIN Session
is the intended consolidation.
_Avoid_: login, auth, unlocked flag.

PIN Session (decided 2026-07-21): one shared session covers all Sensitive surfaces; expires on
idle-reset; explicit close supported; client-only until Slice S.

## Backend work

**Worker Cycle**:
One iteration of a named interval loop that runs on a fixed cadence and reconciles some slice of
desired state against the physical home or an external service (lights, climate, Sonos volume,
weather ingest, poll loops). Cycles never overlap with themselves.
_Avoid_: tick, job (a Queue Job is different), task, cron.

**Enforcer**:
A Worker Cycle whose job is to drive a device's reported state toward its desired state on every
iteration (the desired-state-is-truth pattern). A named subtype of Worker Cycle.
_Avoid_: reconciler, syncer.

**Queue Job**:
 A unit of work claimed from the shared work queue by a worker and run once — as opposed to a
recurring Worker Cycle. Job types include notification delivery.
_Avoid_: task, message, cycle.

**Cron**:
A scheduled Kubernetes job that runs on a calendar schedule (nightly purge, monthly map extract,
database backups) — distinct from both a Worker Cycle (fixed interval, always-on process) and a
Queue Job (claimed from a queue).
_Avoid_: scheduled task, timer.

## The two meanings of "media" (do not use "media" bare)

**AV Control**:
Live control of playback devices — Apple TV and the Sonos sound system (transport, volume,
grouping, app launch, favourites). Backed by one live-queried API slice; no download or storage.
_Avoid_: media, playback (too broad), sound.

## Software factory

**Ticket**:
A unit of requested work owned by the software factory and stored in its own database.
_Avoid_: Issue, GitHub issue.

**Run**:
One attempt to complete a whole Ticket, represented by one Temporal workflow execution.
_Avoid_: Job, session.

**Step**:
One independently executed unit of workflow work inside a Run. A Step has exactly one primary
operation. Temporal may retry that operation without creating another Step or Agent Attempt.
_Avoid_: Phase, every Temporal activity.

**Agent Attempt**:
One workflow-authorized agent execution within one agent-backed Step, potentially spanning native
activity retries and technical resumes. Its identity is scoped to the Step, not to a Codex thread:
Agent Attempt 1 of a new Step may deliberately continue a thread from an earlier Step. Start another
Attempt within the same Step only when the preceding execution cannot be recovered and the workflow
explicitly authorizes another. Infrastructure Steps do not have Agent Attempts.
_Avoid_: Activity retry, Turn, semantic rework.

**Agent Thread**:
The model provider's conversation identity. An Agent Thread may carry implementer context across
multiple Steps and Agent Attempts, while reviewers deliberately start fresh Threads. It is not a
unit of work or retry budget.
_Avoid_: Agent Attempt, Step.

**Activity Retry**:
Temporal repeating the same Step operation after a transient execution failure. An activity retry
does not create a Step or Agent Attempt; an agent activity retry reconciles or resumes the same
Agent Attempt. Its detailed history belongs to Temporal, not the software factory's domain history.
_Avoid_: Agent Attempt, semantic rework.

**Step Result**:
The authoritative domain answer discovered or produced by a completed Step. It
is distinct from Agent Attempt status and activity execution status.
_Avoid_: Agent Attempt status, activity failure, error.

**CI Result**:
The Step Result from observing CI for one exact pull-request head SHA: green, red with bounded
failure evidence, or unobserved. A CI-triggered Implement Step receives this Result explicitly;
resuming the implementer's Agent Thread is not a substitute for the handoff.
_Avoid_: CI status without a head SHA, failed-check fingerprint alone.

**Agent Stage**:
The kind of agent work performed by an agent-backed Step: `plan`, `implement`, or `review`.
_Avoid_: Step, phase.
