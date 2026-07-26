/**
 * Stopwatch store , one panel-wide stopwatch (Apple Clock "Stopwatch" model).
 *
 * Settings.ts idiom: module-level state + a listener Set + useSyncExternalStore,
 * module-level setters, guarded localStorage IO under a `cc-*` key.
 *
 * Elapsed time derives from wall-clock spans , `accumulatedMs` plus the live
 * `now - startedAtMs` span while running , so a deploy reload mid-run keeps
 * counting seamlessly. There is deliberately NO store ticker: nothing here ever
 * cues, and the view derives its readout via requestAnimationFrame while
 * running (a stepping interval would make the centisecond digits visibly
 * stutter instead of blurring like Apple's).
 *
 * Single-tab kiosk assumption: module state is the truth; localStorage is only
 * persistence. A second tab degrades to last-write-wins via the `storage`
 * listener below (state reload, no cue evaluation , there are no cues).
 */

import { genId } from "@www/platform";
import { createStore, useStore } from "../store";
import { stopwatchElapsedMs } from "./pure";
import { onExternalWrite, readJson, writeJson } from "./storage";
import type { StopwatchLap, StopwatchState } from "./types";

const STORAGE_KEY = "cc-stopwatch-v1";

const INITIAL: StopwatchState = {
  running: false,
  startedAtMs: null,
  accumulatedMs: 0,
  lapStartElapsedMs: 0,
  laps: [],
};

// ─── singleton state ──────────────────────────────────────────────────────────

const store = createStore<StopwatchState>(INITIAL);

// ─── best-effort localStorage IO (shared seam: ./storage) ─────────────────────

function isLap(value: unknown): value is StopwatchLap {
  if (typeof value !== "object" || value === null) return false;
  const lap = value as Record<string, unknown>;
  return typeof lap.id === "string" && typeof lap.ms === "number";
}

/** All persistence IO stays behind loadState/persistState so the layer can
 *  swap without touching the store API (see alarm-store's persistence note). */
function loadState(): StopwatchState {
  const parsed = readJson(STORAGE_KEY);
  if (typeof parsed !== "object" || parsed === null) return INITIAL;
  const s = parsed as Record<string, unknown>;
  if (
    typeof s.running !== "boolean" ||
    (s.startedAtMs !== null && typeof s.startedAtMs !== "number") ||
    typeof s.accumulatedMs !== "number" ||
    typeof s.lapStartElapsedMs !== "number" ||
    !Array.isArray(s.laps)
  ) {
    return INITIAL;
  }
  return {
    running: s.running,
    startedAtMs: s.startedAtMs as number | null,
    accumulatedMs: s.accumulatedMs,
    lapStartElapsedMs: s.lapStartElapsedMs,
    laps: s.laps.filter(isLap),
  };
}

function persistState(state: StopwatchState): void {
  writeJson(STORAGE_KEY, { v: 1, ...state });
}

store.set(loadState());

onExternalWrite(STORAGE_KEY, () => {
  store.set(loadState());
});

// ─── setters (module-level, stable) ───────────────────────────────────────────

function mutate(next: StopwatchState): void {
  persistState(next);
  store.set(next);
}

export function startStopwatch(): void {
  const state = store.get();
  if (state.running) return;
  mutate({ ...state, running: true, startedAtMs: Date.now() });
}

export function stopStopwatch(): void {
  const state = store.get();
  if (!state.running || state.startedAtMs === null) return;
  const now = Date.now();
  mutate({
    ...state,
    running: false,
    startedAtMs: null,
    accumulatedMs: state.accumulatedMs + (now - state.startedAtMs),
  });
}

/** Slice a lap at the current elapsed. Running only. Laps keep newest first. */
export function lapStopwatch(): void {
  const state = store.get();
  if (!state.running) return;
  const elapsed = stopwatchElapsedMs(state, Date.now());
  const lap: StopwatchLap = {
    id: genId("lap"),
    ms: elapsed - state.lapStartElapsedMs,
  };
  mutate({ ...state, laps: [lap, ...state.laps], lapStartElapsedMs: elapsed });
}

/**
 * Back to zero , allowed whenever stopped AND elapsed > 0, laps or not (Apple
 * semantics: a lapless stop at 00:12.40 must be resettable). A no-op while
 * running or already at zero.
 */
export function resetStopwatch(): void {
  const state = store.get();
  if (state.running || state.accumulatedMs <= 0) return;
  mutate(INITIAL);
}

// ─── hook ─────────────────────────────────────────────────────────────────────

export function useStopwatch(): StopwatchState {
  return useStore(store);
}

// ─── test seam ────────────────────────────────────────────────────────────────

/** @public , test seam (vitest): the live state without a React render. */
export function _stateForTests(): StopwatchState {
  return store.get();
}

/** @public , test seam (vitest); intentionally unused in app code. */
export function resetStopwatchForTests(): void {
  store.set(INITIAL);
}
