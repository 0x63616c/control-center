// PROTOTYPE — throwaway, answers one question, see prototype-longpress-editmode.tui.ts.
//
// Question: does a debounce-based state machine feel right for "long-press a tile to
// enter edit mode"? Specifically: does it correctly distinguish a tap, a drag-start,
// and a long-press-hold, and does it survive the release-before-threshold and
// move-before-threshold edge cases without weird double-fires?
//
// State machine, no I/O: idle -> pressing -> (held | cancelled) -> idle.
// "held" is a terminal-ish state that only editMode can exit (a real release while
// held enters edit mode; a release while merely pressing is a plain tap).

export type LongPressState =
  | { phase: "idle" }
  | { phase: "pressing"; pressStartMs: number; elapsedMs: number }
  | { phase: "held"; heldSinceMs: number }
  | { phase: "cancelled"; reason: "moved" | "released-early" };

export type LongPressAction =
  | { type: "pointerDown"; nowMs: number }
  | { type: "tick"; nowMs: number }
  | { type: "pointerMove"; distancePx: number }
  | { type: "pointerUp"; nowMs: number }
  | { type: "reset" };

export const LONG_PRESS_THRESHOLD_MS = 500;
export const MOVE_CANCEL_THRESHOLD_PX = 8;

export function initialLongPressState(): LongPressState {
  return { phase: "idle" };
}

export function longPressReducer(state: LongPressState, action: LongPressAction): LongPressState {
  switch (action.type) {
    case "pointerDown":
      if (state.phase !== "idle") return state; // ignore second finger, etc.
      return { phase: "pressing", pressStartMs: action.nowMs, elapsedMs: 0 };

    case "tick":
      if (state.phase !== "pressing") return state;
      {
        const elapsedMs = action.nowMs - state.pressStartMs;
        if (elapsedMs >= LONG_PRESS_THRESHOLD_MS) {
          return { phase: "held", heldSinceMs: action.nowMs };
        }
        return { ...state, elapsedMs };
      }

    case "pointerMove":
      if (state.phase !== "pressing") return state; // moving while held/cancelled is a no-op
      if (action.distancePx >= MOVE_CANCEL_THRESHOLD_PX) {
        return { phase: "cancelled", reason: "moved" };
      }
      return state;

    case "pointerUp":
      if (state.phase === "pressing") {
        // Released before the threshold: a plain tap, not edit mode.
        return { phase: "cancelled", reason: "released-early" };
      }
      if (state.phase === "held") {
        // Real release while held: this is the transition the UI reads as
        // "enter edit mode." Modeled as going back to idle here — the caller
        // (the TUI, or the real tile component) is the one that decides to
        // flip editMode=true on this specific transition (held -> idle via
        // pointerUp), which is exactly the ambiguity worth pressure-testing.
        return { phase: "idle" };
      }
      return state;

    case "reset":
      return { phase: "idle" };

    default:
      return state;
  }
}

/** True exactly on the action/state pair that should flip editMode on. */
export function entersEditMode(prev: LongPressState, action: LongPressAction): boolean {
  return prev.phase === "held" && action.type === "pointerUp";
}
