/**
 * Alarm store , the panel's wall-clock alarms (Apple Clock "Alarms" model).
 *
 * Settings.ts idiom: module-level state + a listener Set + useSyncExternalStore,
 * module-level setters, guarded localStorage IO under a `cc-*` key.
 *
 * `nextFireAtMs` is the SINGLE firing authority: an absolute instant recomputed
 * on add/edit/enable/fire by building a local Date from the alarm's wall fields
 * and rolling forward day-by-day to the next matching weekday. The Date rolling
 * is inherently DST-aware , a 02:30 alarm on spring-forward night resolves to
 * the adjusted instant (iOS-matching), and fall-back's repeated hour fires once
 * because the post-fire recompute pushes past it. An absolute deadline also
 * distinguishes "missed while the app was dead" from "not yet due", which a
 * minute-stamp design cannot.
 *
 * Ring-until-dismissed (Apple): while `firing` is set the `alarmFire` cue
 * replays every 5 s, auto-stopping after 10 min. (`firing` is the state a v2
 * snooze hangs on , no storage migration needed.)
 *
 * Boot missed-alarm handling: a deadline that passed within the 60 s grace
 * window of a (deploy-)reload fires normally on load; older ones resolve
 * silently , one-shots disable, repeats roll forward. No 24-h-late blares.
 *
 * Persistence is device-local localStorage BY DESIGN: the panel is a single
 * fixed wall device, so an alarm is a property of this installation (same
 * argument as `pushEnabled` in settings.ts). The server settings singleton is a
 * flat scalar map , a structured unbounded list abuses it. A DB table + tRPC
 * router is the eventual 10x-100x home; the `{v:1}` envelope, `alarm_<uuid>`
 * ids, and all IO behind loadStored/persist keep that swap store-API-neutral.
 *
 * Single-tab kiosk assumption: module state is the truth. A dev browser beside
 * the kiosk degrades to last-write-wins via the `storage` listener (state
 * reload, NO cue evaluation , the writing tab already cued).
 */

import { genId } from "@www/platform";
import { playCue, warmAudio } from "../sound";
import { createStore, useStoreSelector } from "../store";
import { computeNextFireAtMs, validRepeatDays } from "./pure";
import { onExternalWrite, readJson, writeJson } from "./storage";
import { startTicks } from "./ticker";
import { type AlarmRecord, type AlarmStoreState, BOOT_GRACE_MS } from "./types";

const STORAGE_KEY = "cc-alarms-v1";
/** Replay the fire-cue this often while an alarm is ringing. */
const FIRE_REPLAY_MS = 5_000;
/** Give up ringing (clear `firing`) after this long undismissed. */
const FIRE_AUTO_STOP_MS = 10 * 60_000;

// ─── singleton state ──────────────────────────────────────────────────────────

const store = createStore<AlarmStoreState>({ alarms: [], firing: null });
/** Last fire-cue instant , transient, not persisted (a reload restarts the
 *  5 s cadence from load time). */
let lastFireCueAtMs = 0;

// ─── best-effort localStorage IO (shared seam: ./storage) ─────────────────────

function isAlarmRecord(value: unknown): value is AlarmRecord {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === "string" &&
    (a.label === null || typeof a.label === "string") &&
    typeof a.hour === "number" &&
    typeof a.minute === "number" &&
    Array.isArray(a.repeatDays) &&
    a.repeatDays.every((d): d is number => typeof d === "number") &&
    // Out-of-range/duplicate days would make computeNextFireAtMs return null
    // forever , reject the record at the boundary instead.
    validRepeatDays(a.repeatDays) &&
    typeof a.enabled === "boolean" &&
    (a.nextFireAtMs === null || typeof a.nextFireAtMs === "number")
  );
}

/** All persistence IO stays behind loadStored/persist (see header). */
function loadStored(): AlarmStoreState {
  const parsed = readJson(STORAGE_KEY);
  if (typeof parsed !== "object" || parsed === null) return { alarms: [], firing: null };
  const s = parsed as { alarms?: unknown; firing?: unknown };
  const alarms = Array.isArray(s.alarms) ? s.alarms.filter(isAlarmRecord) : [];
  let firing: AlarmStoreState["firing"] = null;
  if (typeof s.firing === "object" && s.firing !== null) {
    const f = s.firing as Record<string, unknown>;
    if (typeof f.alarmId === "string" && typeof f.sinceMs === "number") {
      firing = { alarmId: f.alarmId, sinceMs: f.sinceMs };
    }
  }
  return { alarms, firing };
}

function persist(s: AlarmStoreState): void {
  writeJson(STORAGE_KEY, { v: 1, alarms: s.alarms, firing: s.firing });
}

// ─── shared tick ──────────────────────────────────────────────────────────────

let releaseTick: (() => void) | null = null;

/** A ticker handle is held whenever ≥1 ENABLED alarm exists or one is firing. */
function tickerNeeded(): boolean {
  const state = store.get();
  return state.firing !== null || state.alarms.some((a) => a.enabled);
}

function syncTicker(): void {
  if (tickerNeeded()) {
    if (releaseTick === null) releaseTick = startTicks(tick);
  } else if (releaseTick !== null) {
    releaseTick();
    releaseTick = null;
  }
}

/** Resolve one due alarm past its deadline: one-shots disable, repeats roll. */
function rollPastFire(alarm: AlarmRecord, nowMs: number): AlarmRecord {
  return alarm.repeatDays.length === 0
    ? { ...alarm, enabled: false, nextFireAtMs: null }
    : { ...alarm, nextFireAtMs: computeNextFireAtMs(alarm, nowMs) };
}

function tick(nowMs: number): void {
  let state = store.get();
  let changed = false;

  // Ring-until-dismissed nag / auto-stop.
  if (state.firing !== null) {
    if (nowMs - state.firing.sinceMs >= FIRE_AUTO_STOP_MS) {
      state = { ...state, firing: null };
      changed = true;
    } else if (nowMs - lastFireCueAtMs >= FIRE_REPLAY_MS) {
      lastFireCueAtMs = nowMs;
      playCue("alarmFire");
    }
  }

  // Deadline crossings. Recompute-forward means an alarm can never double-fire:
  // the moment it fires its own nextFireAtMs moves past now (or nulls).
  const due = state.alarms.filter(
    (a) => a.enabled && a.nextFireAtMs !== null && a.nextFireAtMs <= nowMs,
  );
  if (due.length > 0) {
    changed = true;
    let firing = state.firing;
    const alarms = state.alarms.map((a) => {
      if (!due.includes(a)) return a;
      // First-come keeps the bell: a second alarm due while one rings still
      // rolls forward, but the ringing surface stays on the first.
      if (firing === null) firing = { alarmId: a.id, sinceMs: nowMs };
      return rollPastFire(a, nowMs);
    });
    state = { alarms, firing };
    lastFireCueAtMs = nowMs;
    playCue("alarmFire");
  }

  if (changed) {
    persist(state);
    store.set(state);
    syncTicker();
  }
}

// ─── boot ─────────────────────────────────────────────────────────────────────

function boot(nowMs: number): void {
  const loaded = loadStored();
  // A ring persisted across reload keeps ringing, unless its 10 min already ran.
  let firing =
    loaded.firing !== null && nowMs - loaded.firing.sinceMs < FIRE_AUTO_STOP_MS
      ? loaded.firing
      : null;
  let fired = false;
  const alarms = loaded.alarms.map((a) => {
    if (!a.enabled || a.nextFireAtMs === null || a.nextFireAtMs > nowMs) return a;
    if (nowMs - a.nextFireAtMs <= BOOT_GRACE_MS) {
      // Missed only by the reload itself , fire normally.
      fired = true;
      if (firing === null) firing = { alarmId: a.id, sinceMs: nowMs };
    }
    // Beyond the grace window: resolve silently, no 24-h-late blares.
    return rollPastFire(a, nowMs);
  });
  const state: AlarmStoreState = { alarms, firing };
  if (fired) {
    lastFireCueAtMs = nowMs;
    playCue("alarmFire");
  }
  persist(state);
  store.set(state);
  syncTicker();
}

boot(Date.now());

onExternalWrite(STORAGE_KEY, () => {
  store.set(loadStored());
  syncTicker();
});

// ─── setters (module-level, stable) ───────────────────────────────────────────

function mutate(next: AlarmStoreState): void {
  persist(next);
  store.set(next);
  syncTicker();
}

export interface AlarmInput {
  hour: number;
  minute: number;
  /** ISO 1-7 Mon..Sun; [] (default) = one-shot. */
  repeatDays?: number[];
  label?: string;
}

function validWallTime(hour: number, minute: number): boolean {
  return (
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23 &&
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59
  );
}

/** Add an enabled alarm. Gesture path , warms audio for the eventual fire. */
export function addAlarm(input: AlarmInput): void {
  warmAudio();
  if (!validWallTime(input.hour, input.minute) || !validRepeatDays(input.repeatDays ?? [])) return;
  const now = Date.now();
  const alarm: AlarmRecord = {
    id: genId("alarm"),
    label: input.label ?? null,
    hour: input.hour,
    minute: input.minute,
    repeatDays: input.repeatDays ?? [],
    enabled: true,
    nextFireAtMs: 0,
  };
  alarm.nextFireAtMs = computeNextFireAtMs(alarm, now);
  const state = store.get();
  mutate({ ...state, alarms: [...state.alarms, alarm] });
}

export function updateAlarm(
  id: string,
  patch: Partial<Pick<AlarmRecord, "label" | "hour" | "minute" | "repeatDays" | "enabled">>,
): void {
  warmAudio();
  const state = store.get();
  if (!state.alarms.some((a) => a.id === id)) return;
  const now = Date.now();
  mutate({
    ...state,
    alarms: state.alarms.map((a) => {
      if (a.id !== id) return a;
      const merged = { ...a, ...patch };
      if (!validWallTime(merged.hour, merged.minute) || !validRepeatDays(merged.repeatDays)) {
        return a;
      }
      return {
        ...merged,
        // An edit re-anchors the deadline; a disabled alarm has none.
        nextFireAtMs: merged.enabled ? computeNextFireAtMs(merged, now) : null,
      };
    }),
  });
}

export function deleteAlarm(id: string): void {
  warmAudio();
  const state = store.get();
  if (!state.alarms.some((a) => a.id === id)) return;
  mutate({
    alarms: state.alarms.filter((a) => a.id !== id),
    firing: state.firing?.alarmId === id ? null : state.firing,
  });
}

export function toggleAlarm(id: string, enabled: boolean): void {
  warmAudio();
  const state = store.get();
  if (!state.alarms.some((a) => a.id === id)) return;
  const now = Date.now();
  mutate({
    alarms: state.alarms.map((a) =>
      a.id === id
        ? { ...a, enabled, nextFireAtMs: enabled ? computeNextFireAtMs(a, now) : null }
        : a,
    ),
    // Disabling a ringing alarm also silences it.
    firing: !enabled && state.firing?.alarmId === id ? null : state.firing,
  });
}

/** Stop the ringing (the alarm itself already rolled/disabled at fire time). */
export function dismissAlarmFiring(): void {
  warmAudio();
  const state = store.get();
  if (state.firing === null) return;
  mutate({ ...state, firing: null });
}

// ─── hooks ────────────────────────────────────────────────────────────────────

export function useAlarms(): AlarmRecord[] {
  return useStoreSelector(store, (s) => s.alarms);
}

export function useAlarmFiring(): AlarmStoreState["firing"] {
  return useStoreSelector(store, (s) => s.firing);
}

// ─── test seam ────────────────────────────────────────────────────────────────

/** @public , test seam (vitest): the live state without a React render. */
export function _alarmStateForTests(): AlarmStoreState {
  return store.get();
}

/** @public , test seam (vitest); intentionally unused in app code. */
export function resetAlarmsForTests(): void {
  store.set({ alarms: [], firing: null });
  lastFireCueAtMs = 0;
  if (releaseTick !== null) {
    releaseTick();
    releaseTick = null;
  }
}
