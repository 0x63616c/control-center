/**
 * Timer store , the panel's countdown timers (Apple Clock "Timers" model).
 *
 * Settings.ts idiom: module-level state + a listener Set + useSyncExternalStore,
 * module-level setters, guarded localStorage IO under a `cc-*` key.
 *
 * Everything derives from ABSOLUTE deadlines (`endsAtMs`): remaining time is
 * `max(0, endsAtMs - now)`, so timer accuracy is immune to interval drift,
 * background throttling, and , the common case in this repo, where every push
 * to main hard-reloads the app , deploy reloads. The module load path resumes
 * whatever was running: deadlines still in the future keep ticking; deadlines
 * that passed within the boot grace window fire their cue on load (a deploy in
 * a timer's final seconds must not eat the beep); older ones resolve to a
 * silent done card.
 *
 * Completion behavior matches Apple: a finished timer RINGS until stopped ,
 * the initial `timerDone` cue at the crossing, a replay every 8 s while any
 * done timer is un-dismissed, auto-silencing after 5 min (the card stays).
 *
 * Single-tab kiosk assumption: the panel runs exactly one app instance, so
 * module state IS the truth and localStorage is only a persistence layer. A dev
 * browser open beside the kiosk degrades to last-write-wins: each instance also
 * listens for `storage` events on its key and reloads state (with NO cue
 * evaluation), so the non-writing tab follows along without double cues.
 */

import { genId } from "@www/platform";
import { playCue, warmAudio } from "../sound";
import { createStore, useStore, useStoreSelector } from "../store";
import { onExternalWrite, readJson, writeJson } from "./storage";
import { startTicks } from "./ticker";
import { BOOT_GRACE_MS, type TimerRecord } from "./types";

const STORAGE_KEY = "cc-timers-v1";
/** Replay the done-cue this often while a done timer is un-dismissed. */
const NAG_REPLAY_MS = 8_000;
/** Stop nagging (auto-dismiss the cue, keep the card) after this long done. */
const NAG_AUTO_SILENCE_MS = 5 * 60_000;

// ─── singleton state ──────────────────────────────────────────────────────────

const store = createStore<TimerRecord[]>([]);
/** Last nag-cue instant per timer , transient, deliberately NOT persisted
 *  (a reload just restarts the 8 s cadence from load time). */
const lastCueAtMs = new Map<string, number>();

// ─── best-effort localStorage IO (shared seam: ./storage) ─────────────────────

function isTimerRecord(value: unknown): value is TimerRecord {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    (t.label === null || typeof t.label === "string") &&
    typeof t.durationMs === "number" &&
    (t.endsAtMs === null || typeof t.endsAtMs === "number") &&
    typeof t.remainingMs === "number" &&
    (t.state === "running" || t.state === "paused" || t.state === "done") &&
    (t.doneAtMs === null || typeof t.doneAtMs === "number") &&
    typeof t.dismissedCue === "boolean" &&
    typeof t.createdAtMs === "number"
  );
}

/** All persistence IO stays behind loadTimers/persistTimers so the layer can
 *  swap (localStorage → tRPC-backed table) without touching the store API. */
function loadTimers(): TimerRecord[] {
  const parsed = readJson(STORAGE_KEY);
  if (typeof parsed !== "object" || parsed === null) return [];
  const list = (parsed as { v?: unknown; timers?: unknown }).timers;
  if (!Array.isArray(list)) return [];
  return list.filter(isTimerRecord);
}

function persistTimers(timers: TimerRecord[]): void {
  writeJson(STORAGE_KEY, { v: 1, timers });
}

// ─── shared tick ──────────────────────────────────────────────────────────────

let releaseTick: (() => void) | null = null;

/** A ticker handle is held only while ≥1 timer is running OR a nag is live. */
function tickerNeeded(): boolean {
  return store.get().some((t) => t.state === "running" || (t.state === "done" && !t.dismissedCue));
}

function syncTicker(): void {
  if (tickerNeeded()) {
    if (releaseTick === null) releaseTick = startTicks(tick);
  } else if (releaseTick !== null) {
    releaseTick();
    releaseTick = null;
  }
}

function tick(nowMs: number): void {
  let changed = false;
  const timers = store.get().map((t) => {
    // Deadline crossing: exactly one initial cue, then the nag takes over.
    if (t.state === "running" && t.endsAtMs !== null && t.endsAtMs <= nowMs) {
      changed = true;
      lastCueAtMs.set(t.id, nowMs);
      playCue("timerDone");
      return { ...t, state: "done" as const, endsAtMs: null, remainingMs: 0, doneAtMs: t.endsAtMs };
    }
    if (t.state === "done" && !t.dismissedCue && t.doneAtMs !== null) {
      if (nowMs - t.doneAtMs >= NAG_AUTO_SILENCE_MS) {
        changed = true;
        return { ...t, dismissedCue: true };
      }
      const last = lastCueAtMs.get(t.id) ?? t.doneAtMs;
      if (nowMs - last >= NAG_REPLAY_MS) {
        lastCueAtMs.set(t.id, nowMs);
        playCue("timerDone");
      }
    }
    return t;
  });
  // Persist + emit on state TRANSITIONS only , steady ticks (and nag replays)
  // write nothing, so a running timer costs zero storage churn.
  if (changed) {
    persistTimers(timers);
    store.set(timers);
    syncTicker();
  }
}

// ─── boot resume ──────────────────────────────────────────────────────────────

/** Module load path: deserialize, resolve passed deadlines (grace window per
 *  types.ts), and , critically , reacquire the ticker when anything is live, so
 *  a deploy reload alone restarts ticking with no user mutation. */
function bootResume(nowMs: number): void {
  let changed = false;
  const timers = loadTimers().map((t) => {
    if (t.state === "running" && t.endsAtMs !== null && t.endsAtMs <= nowMs) {
      changed = true;
      const done = {
        ...t,
        state: "done" as const,
        endsAtMs: null,
        remainingMs: 0,
        doneAtMs: t.endsAtMs,
      };
      if (nowMs - t.endsAtMs <= BOOT_GRACE_MS) {
        // Expired during the reload itself , the beep still belongs to the user.
        lastCueAtMs.set(t.id, nowMs);
        playCue("timerDone");
        return { ...done, dismissedCue: false };
      }
      return { ...done, dismissedCue: true };
    }
    if (t.state === "done" && !t.dismissedCue && t.doneAtMs !== null) {
      // A nag that outlived its cap while we were away silences without a cue.
      if (nowMs - t.doneAtMs >= NAG_AUTO_SILENCE_MS) {
        changed = true;
        return { ...t, dismissedCue: true };
      }
      // Nag continues on its cadence from load (no immediate replay).
      lastCueAtMs.set(t.id, nowMs);
    }
    return t;
  });
  store.set(timers);
  if (changed) persistTimers(timers);
  syncTicker();
}

bootResume(Date.now());

// Cross-tab follow (single-tab kiosk assumption above): reload state on an
// external write, with NO cue evaluation , the writing tab already cued.
onExternalWrite(STORAGE_KEY, () => {
  store.set(loadTimers());
  syncTicker();
});

// ─── setters (module-level, stable) ───────────────────────────────────────────

function mutate(next: TimerRecord[]): void {
  persistTimers(next);
  store.set(next);
  syncTicker();
}

function patchTimer(id: string, patch: (t: TimerRecord) => TimerRecord): void {
  const timers = store.get();
  if (!timers.some((t) => t.id === id)) return;
  mutate(timers.map((t) => (t.id === id ? patch(t) : t)));
}

/** Start a new running timer. Gesture path , warms the audio context (§ the
 *  sound bus header) so the eventual unattended `timerDone` can sound. */
export function addTimer(durationMs: number, label?: string): void {
  warmAudio();
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const now = Date.now();
  const timer: TimerRecord = {
    id: genId("timer"),
    label: label ?? null,
    durationMs,
    endsAtMs: now + durationMs,
    remainingMs: durationMs,
    state: "running",
    doneAtMs: null,
    dismissedCue: false,
    createdAtMs: now,
  };
  mutate([...store.get(), timer]);
}

export function pauseTimer(id: string): void {
  warmAudio();
  const now = Date.now();
  patchTimer(id, (t) =>
    t.state === "running" && t.endsAtMs !== null
      ? { ...t, state: "paused", remainingMs: Math.max(0, t.endsAtMs - now), endsAtMs: null }
      : t,
  );
}

export function resumeTimer(id: string): void {
  warmAudio();
  const now = Date.now();
  patchTimer(id, (t) =>
    t.state === "paused" ? { ...t, state: "running", endsAtMs: now + t.remainingMs } : t,
  );
}

export function deleteTimer(id: string): void {
  warmAudio();
  const timers = store.get();
  if (!timers.some((t) => t.id === id)) return;
  lastCueAtMs.delete(id);
  mutate(timers.filter((t) => t.id !== id));
}

/** Clear a DONE timer's card (ringing or not). Running/paused timers are
 *  removed via deleteTimer. */
export function dismissTimer(id: string): void {
  warmAudio();
  const timers = store.get();
  const timer = timers.find((t) => t.id === id);
  if (timer === undefined || timer.state !== "done") return;
  lastCueAtMs.delete(id);
  mutate(timers.filter((t) => t.id !== id));
}

/** Stop a done timer's ringing; the card stays. */
export function stopTimerRinging(id: string): void {
  warmAudio();
  patchTimer(id, (t) => (t.state === "done" && !t.dismissedCue ? { ...t, dismissedCue: true } : t));
}

/** Re-run a timer from its original duration (Apple's restart affordance). */
export function restartTimer(id: string): void {
  warmAudio();
  const now = Date.now();
  patchTimer(id, (t) => ({
    ...t,
    state: "running",
    endsAtMs: now + t.durationMs,
    remainingMs: t.durationMs,
    doneAtMs: null,
    dismissedCue: false,
  }));
}

// ─── hooks ────────────────────────────────────────────────────────────────────

export function useTimers(): TimerRecord[] {
  return useStore(store);
}

/** True while any done timer is still un-dismissed (ringing/nagging). */
export function useTimersRinging(): boolean {
  return useStoreSelector(store, (timers) =>
    timers.some((t) => t.state === "done" && !t.dismissedCue),
  );
}

// ─── test seams ───────────────────────────────────────────────────────────────

/** @public , test seam (vitest); intentionally unused in app code. */
export function resetTimersForTests(): void {
  store.set([]);
  lastCueAtMs.clear();
  if (releaseTick !== null) {
    releaseTick();
    releaseTick = null;
  }
}

/** @public , test seam (vitest); intentionally unused in app code. */
export function _tickForTests(nowMs: number): void {
  tick(nowMs);
}

/** @public , test seam (vitest): the live list without a React render. */
export function _timersForTests(): TimerRecord[] {
  return store.get();
}
