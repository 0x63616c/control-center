# Frontend debug logs: in-app log viewer for control-center web

Date: 2026-07-13
Status: design, awaiting approval

## Problem

The wall panel currently says "Unable to connect…" and there is no way to find out
why. `ConnectionLostBanner` (`web/src/components/ConnectionLostBanner.tsx:15`) is
driven by `useConnectionStatus` (`web/src/lib/useConnectionStatus.ts:17`), which
infers "lost" from a sustained error state in the React Query cache after 8s. It
never records *which* query failed, or with what error. The cause is thrown away.

More broadly, the web app has no logging. Two stray `console.error` calls exist
(`TileBoundary.tsx:59`, `TeslaMap.tsx:64`) and nothing else. `docs/logging.md` §7
explicitly parked the web app as out of scope for the backend structured-logging
effort, with a note to pick it up later. This is that ticket.

The panel is a TestFlight Capacitor kiosk shell (`web/capacitor.config.ts`) whose
`server.url` points at the hosted dashboard, so it renders remote content in a
WKWebView on an iPad Pro 12.9 (the `1366x1024` invariant). There is no Chromium,
so no CDP / `chrome://inspect` / Playwright remote debugging. Safari Web Inspector
cannot attach either: a TestFlight release build has `isInspectable = false`, so
even a tethered Mac gets nothing. There is no back door into that app. The in-app
viewer is therefore the *only* window into it, which is what makes the export
action below load-bearing rather than a convenience.

## Goals

- Read the frontend's logs on the device, from Settings, with no network involved.
- Retain history across the reload or crash that caused the problem.
- Emit enough that the logs describe what the app is *doing*, not just what the
  network did.

## Non-goals

- Shipping logs to a backend. Local-only. The homelab is a RAM-constrained 8GB Mac
  Mini and its previous prometheus/grafana/loki stack was deliberately removed on
  2026-06-02 to run lean; Faro/Loki and GlitchTip both mean standing that back up.
  Remote viewing, if ever wanted, is a separate project layered on top of this one.
- Session replay (rrweb, OpenReplay).
- A remote-DevTools bridge (Chii). Viable, and worth revisiting, but orthogonal.

> **Note added 2026-07-26 (#33).** The first non-goal's *constraint* no longer
> holds: the 8GB Mac mini was retired on 2026-07-25, prod is now the home-server
> Talos node, and a Prometheus/Loki/Grafana stack was stood back up there (#33,
> #216 — see `docs/observability.md`). The decision it justified still stands as
> written: the panel's own logs are captured locally and ship to **Postgres**
> (`frontend_log`, `2026-07-18-frontend-log-shipping-design.md`), not to Loki.
> Loki collects container logs. Nothing below is retracted; only the "we have no
> such stack" premise is out of date.

## Decisions

**Always-on, not flag-gated.** You cannot capture the crash you did not anticipate
behind a flag you enable after it happens. The logger runs in production by
default. (This is why in-page devtools like `eruda` were rejected as the primary
answer: eruda only captures from `eruda.init()` onward, so it must run at boot to
be useful, and it holds no history across a reload.)

**Two layers.** A 5k-entry in-memory ring buffer is what the modal reads — instant,
synchronous, no await. IndexedDB holds up to 100k entries and is what survives a
reload. The native `KioskWatchdog` (`web/ios/App/App`) already reloads the webview
on failure, so every failure the panel automates around destroys the in-memory
buffer. The persistent layer is load-bearing, not a nice-to-have.

**Batched async flush.** Every ~3s and on `visibilitychange`. Never per-entry, never
synchronous. A `log.info()` call must cost an array write and a queue push, nothing
more — the panel is an always-on kiosk with an FPS meter, and logging that costs
frames is a failed feature.

**Rotation is a rolling window**, evicting on *both* entry count (100k) and total
bytes (~50MB), whichever trips first. Count-only eviction is how you discover the
disk filled up. Each entry's `data` is truncated to ~2KB and flagged as truncated,
so one large payload (a media playlist, a device-state dump) cannot blow the cap.

**Payloads are always logged.** The tRPC link records procedure, duration, HTTP
status, error shape AND the request input. This was originally shipped behind a
`logPayloads` toggle defaulting to off, on the reasoning that an always-on logger
writing plaintext to IndexedDB would persist Tesla coordinates, camera stream URLs
and auth tokens on a wall-mounted device, diverging from `docs/logging.md` §4
("Redaction, secrets are NEVER logged"). The panel's owner overrode that: this is
a private device on a home network that only he can physically reach, the logs
never leave it, and a failure whose input you cannot see is a failure you end up
guessing about. The divergence from §4 is therefore deliberate and scoped to the
web app, not an oversight.

**IndexedDB, not OPFS or SQLite-WASM.** OPFS sync access handles are WebKit's least
mature storage surface and require a Worker; SQLite-WASM adds ~1MB of wasm to query
a few thousand rows. IndexedDB behaves identically in the panel's WKWebView and any
browser, so there is one code path. Accessed via `idb` (~1KB wrapper).

**Storage durability caveat.** Because the Capacitor shell loads *remote* content
rather than a bundled local scheme, the WKWebView origin is a normal remote HTTPS
origin and iOS ITP's 7-day purge of script-writable storage applies. Daily use of
the panel resets that clock, so in practice history should persist. We call
`navigator.storage.persist()` at boot to request an exemption (WebKit grants it
heuristically). If history is ever observed evaporating, the escape hatch is
writing through the Capacitor bridge to native storage (`@capacitor/filesystem`),
which is ITP-immune — at the cost of forking the storage layer per target. Not
doing that now.

**Dependency-free, not pino's browser build.** An earlier draft of this design put
`pino/browser` behind a `write` hook feeding the ring, for monorepo consistency.
Rejected on build: pino's browser build brings levels and the record shape but no
buffering, rotation or persistence, so it saves ~40 lines while adding a runtime
dependency to the wall panel's bundle — and `docs/logging.md` §7 explicitly
sanctions "a 20-line console wrapper" for the web app rather than pino. The logger
keeps the same `info/warn/error` vocabulary and a `child(source)` binding, so call
sites read the same as the backend's; only the implementation differs.

## Architecture

```
log.info(...) ──┐
console.*    ───┤
window.onerror ─┼──> logger ──> ring (5k, sync, instant)
tRPC link    ───┘        │
                         └──> flush queue ──(~3s + visibilitychange)──> IndexedDB (100k)

LogsModal ──> ring (live tail)
          └──> store.query() (scroll back / filter)
```

The rest of the app imports only `logger.ts`. It does not know that a ring buffer,
IndexedDB, or the modal exist. Swapping the persistence layer changes nothing
outside `lib/log/`.

### Modules

| Module | Responsibility |
| --- | --- |
| `web/src/lib/log/ring.ts` | Fixed-size in-memory ring buffer, 5k entries, O(1) push with wraparound. No deps, no I/O. Pure; unit-tested. |
| `web/src/lib/log/store.ts` | IndexedDB layer. Object store `logs` keyed by monotonic `seq`, indexed on `ts` and `level`. `append`, `query({level?, source?, search?, before?, limit})`, `prune`. Rotation and byte accounting live here. |
| `web/src/lib/log/logger.ts` | Public API. `log.debug/info/warn/error(msg, data?)` plus `log.child({ source })`. Writes the ring synchronously, queues for flush. The only module the app imports. |
| `web/src/lib/log/capture.ts` | Automatic sources: patches `console.*`, installs `window.onerror` and `unhandledrejection`. Called once at boot. |
| `web/src/lib/log/trpc-link.ts` | tRPC link logging every call's procedure, duration, HTTP status and error shape. |
| `web/src/components/LogsModal.tsx` | The viewer. Virtualised list, filter by level/source, text search, export/copy. |

The two things that are hard to test (browser storage, global patching) are
isolated in `store.ts` and `capture.ts`, leaving the tricky logic in `ring.ts` as a
pure function.

### Entry shape

```ts
type LogEntry = {
  id: string;         // `${bootMs}-${seq}`, zero-padded. The IDB key.
  seq: number;        // within-session counter; NOT unique across reloads
  ts: number;         // epoch ms
  level: "debug" | "info" | "warn" | "error";
  source: string;     // e.g. "tile:weather", "trpc", "boot", "console"
  msg: string;
  data?: unknown;     // truncated to ~2KB, flagged when truncated
  truncated?: boolean;
};
```

The `id`/`seq` split is not decoration. The first implementation keyed IndexedDB
on `seq` alone, which restarts at 0 on every page load — so each reload silently
overwrote the previous session's rows one for one, and the store only ever held
the current session. That destroys exactly the history this layer exists to keep,
since the watchdog reloads the webview on failure and the interesting boot is
therefore always the *previous* one. Caught by driving a real browser and
reloading it, not by any test that existed at the time; `log-store.test.ts` now
pins the behaviour.

## Instrumentation

The logger is the pipes; the value is what flows through them. A viewer over an app
that logs nothing shows an empty screen — which is the situation today. So this
change also instruments the app broadly.

### Automatic sources (no call sites; catch what you did not anticipate)

1. **`console.*` patched at boot** — picks up the existing calls in
   `TileBoundary.tsx:59` and `TeslaMap.tsx:64`, plus React's own warnings. Free
   signal.
2. **`window.onerror` + `unhandledrejection`** — crashes, with stack traces. On a
   kiosk that self-reloads via the watchdog, this is precisely the evidence that
   evaporates today.
3. **tRPC link** — every call: procedure, duration, HTTP status, error shape.
4. **React Query cache subscriber** — a logging sibling of the existing subscriber
   at `useConnectionStatus.ts:48`: every query transition to `error`, every retry,
   every recovery. Combined with (3), the log reads
   `weather.current → error (502) ×3 → connectionStatus: online → lost`, which is
   the sentence the current banner cannot say.

### Explicit instrumentation

- **Boot** — app start, build hash, settings snapshot, first render, tRPC client
  ready, and watchdog-triggered reloads. So a failed boot shows how far it got.
- **Connection** — every `useConnectionStatus` transition with the *reason*
  attached. This is what lets `ConnectionLostBanner` explain itself.
- **Tiles** — mount, first data, error (via `TileBoundary`), unmount. Tagged with a
  child logger per tile: `log.child({ source: "tile:weather" })`.
- **Board** — pan, snap, recenter, idle-dim on/off. Context around "why did it do
  that".
- **Settings** — every change. Trivial, since the setters are module-level in
  `lib/settings.ts`.
- **Data layer** — camera stream connect/fail, media jobs, HA calls.

The existing `console.error` calls in `TileBoundary.tsx` and `TeslaMap.tsx` are
replaced with `log.error`.

### Level policy

Everything is captured to the ring at every level, including `debug`. Filtering
happens in the *viewer*, not at write time — the opposite of a server logger, where
`debug` is suppressed in prod. Here the cost of keeping `debug` is ring space
already paid for, and the one time it is needed it will be there.

### Volume guard

High-frequency events must not be logged per-frame. Board pan logged per-frame
would make 100k entries roughly twenty minutes of history instead of weeks. Gesture
events log on *gesture end*; anything else chatty is `debug` and rate-limited.

## UI

`SettingsPanel.tsx` footer (currently `justifyContent: "flex-end"`, line 227)
becomes `space-between`: **View logs** on the left, **Reset to defaults** stays on
the right. "View logs" opens `LogsModal`.

`LogsModal` renders a virtualised list — 100k rows in the DOM would jank — showing
the live tail from the ring and paging older entries from IndexedDB as you scroll
back or filter. Filters: level, source, free-text search. An **export/copy** action
puts the current view on the clipboard, which is how logs leave the device without
building a shipping pipeline.

Storybook-first, using the shared primitives in `web/src/components/ui/`, with
stories driven by real buffer shapes (no fake data, per the repo invariants).

## Testing

- `ring.ts` — unit tests: wraparound, eviction order, capacity.
- `store.ts` — tests against `fake-indexeddb`: append, query by level/source/search,
  prune on both count and byte caps, truncation.
- `trpc-link.ts` — unit test that a failing call produces an entry with the
  procedure, status and error.
- `LogsModal` — Storybook stories plus an agent-browser screenshot verifying the
  modal renders at 1366x1024.

## Follow-ups, not in this change

- Rewrite `docs/logging.md` §7 to point at this design instead of describing it as
  future work.
- Set `loggingBehavior: 'production'` in `capacitor.config.ts` so a tethered iPad
  still emits native logs on release builds.
- Optional: `eruda` behind a "Deep dive" button in `LogsModal` for raw
  network/DOM/storage inspection. It must init at boot to capture anything, so it
  would be gated on a persisted setting, not lazy-loaded on click.
- Optional: a Chii container on the homelab for untethered real Chrome DevTools
  against the panel from a laptop.
