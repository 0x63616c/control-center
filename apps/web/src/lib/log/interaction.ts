/**
 * interaction , the human-activity channel of the frontend log.
 *
 * Everything else in `lib/log/` records what the MACHINE did: fetches, errors,
 * query retries, boot. This module records what a PERSON did, so that a month
 * later "what happened at the panel on Tuesday evening" is one SQL predicate
 * (`where source = 'ui'`) rather than a grep through network noise.
 *
 * WHY a separate channel rather than scattered `log.debug("tile tapped")` calls:
 *
 * - Queryability. Freeform debug lines interleave with thousands of fetch/query
 *   entries, so reconstructing a visit means guessing at message strings. A
 *   dedicated source makes the human timeline a first-class thing you can select.
 * - Shape. `(surface, action, target)` is a fixed vocabulary, so events aggregate
 *   over time ("which tiles actually get touched?"). Prose messages drift and
 *   cannot be grouped.
 *
 * HUMAN-ORIGIN ONLY. A light changing because Home Assistant pushed an update is
 * not something a person did, and must NOT come through here , the moment device
 * echoes land on this channel, "what a person did" stops meaning that and every
 * query needs a filter. Device-driven state changes stay on the normal debug
 * channel. Idle/dim transitions are the one sanctioned exception (see `session`
 * below): they are not interactions, but they bracket them, and a visit that
 * ends is part of the visit's record.
 *
 * Entries are emitted at `info`. Level is not the axis that separates human from
 * machine here , `source` is , and info means a routine, expected event, which
 * is exactly what a tap is.
 */

import { genId } from "@www/platform";
import { log } from "./logger";

/** The broad area of the UI a person touched. */
export type InteractionSurface =
  | "tile"
  | "modal"
  | "control"
  | "nav"
  | "settings"
  | "gesture"
  | "session";

/** What they did to it. */
export type InteractionAction =
  | "tap"
  | "open"
  | "close"
  | "change"
  | "commit"
  | "pan"
  | "jump"
  | "recenter"
  | "wake"
  | "idle";

const uiLog = log.child("ui");

/**
 * How long a session survives with no interaction before it is considered over.
 *
 * The panel is always on and never "logs out", so without a timeout every event
 * ever recorded belongs to one infinite session and the grouping is worthless.
 * 60s is comfortably longer than the pause between two deliberate taps (reading
 * a tile, deciding) and far shorter than the gap between two people visiting.
 */
const SESSION_IDLE_MS = 60_000;

/**
 * Grace window in which a NEW interaction re-adopts the session that just ended.
 *
 * Someone who steps away, lets the panel dim, and comes straight back is on one
 * visit, not two , and a dim boundary mid-thought would split the transcript at
 * the least useful moment. Shorter than SESSION_IDLE_MS on purpose: this window
 * only applies after an explicit end (idle/dim), which is a stronger signal that
 * the visit was over than mere silence.
 */
const SESSION_RESUME_MS = 30_000;

let sessionId: string | null = null;
/** Monotonic index within the current session, so a transcript orders exactly. */
let sessionIdx = 0;
/** Event count + start, carried into the session's closing entry. */
let sessionStartedAt = 0;
/** When the last session ended, for the resume window. Null while one is live. */
let lastEndedAt: number | null = null;
/** The id of the session that just ended, eligible for resume. */
let lastSessionId: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function newSessionId(): string {
  return genId("isn", { length: 12 });
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => endInteractionSession("timeout"), SESSION_IDLE_MS);
}

/**
 * Open a session if none is live, resuming the previous one inside the grace
 * window. Called implicitly by every `interaction()`, so no caller has to
 * remember to start one , a session exists because someone did something, which
 * is the only definition that cannot drift out of sync with reality.
 */
function ensureSession(now: number): void {
  if (sessionId) return;
  const resumable =
    lastSessionId !== null && lastEndedAt !== null && now - lastEndedAt <= SESSION_RESUME_MS;
  if (resumable) {
    sessionId = lastSessionId;
  } else {
    sessionId = newSessionId();
    sessionIdx = 0;
    sessionStartedAt = now;
    uiLog.info("session/start", { interactionSessionId: sessionId, idx: 0 });
  }
  lastEndedAt = null;
}

/**
 * Close the current session, if any, and record its shape.
 *
 * `reason` distinguishes a visit that simply went quiet ("timeout") from one the
 * panel actively ended ("idle-dim", "idle-reset") , the latter means the wall
 * went back to the clock, which is a real event in the room, not just an absence
 * of taps.
 */
export function endInteractionSession(reason: string): void {
  if (!sessionId) return;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const now = Date.now();
  uiLog.info("session/end", {
    interactionSessionId: sessionId,
    idx: sessionIdx + 1,
    reason,
    events: sessionIdx,
    durationMs: now - sessionStartedAt,
  });
  lastSessionId = sessionId;
  lastEndedAt = now;
  sessionId = null;
}

/**
 * Record one human interaction.
 *
 * `target` is a stable dotted id , `tile_climate`, `control.lamp.desk`,
 * `modal.Settings` , NOT a display string. It is the grouping key for every
 * later "how often is this touched" question, so it must survive a copy edit.
 */
export function interaction(
  surface: InteractionSurface,
  action: InteractionAction,
  target: string,
  detail?: Record<string, unknown>,
): void {
  const now = Date.now();
  ensureSession(now);
  sessionIdx += 1;
  armIdleTimer();
  uiLog.info(`${surface}/${action}`, {
    ...detail,
    target,
    interactionSessionId: sessionId,
    idx: sessionIdx,
  });
}

/**
 * Force-open a NEW session, ending any live one first.
 *
 * Called on undim. An undim is a PHYSICAL boundary , someone walked up to a
 * dark panel , so it outranks the resume window, which exists only to stitch
 * together a visit that timing alone would have split. Deliberately does not
 * consult `lastSessionId`: a fresh approach is a fresh visit even if the last
 * one ended two seconds ago.
 *
 * Returns the id so the caller can hand it to the wake-photo upload, which is
 * what makes a photo and a transcript the same visit.
 */
export function startInteractionSession(): string {
  endInteractionSession("superseded");
  const now = Date.now();
  sessionId = newSessionId();
  sessionIdx = 0;
  sessionStartedAt = now;
  // Suppress the resume path for the interaction that follows this wake , the
  // session we just minted IS the one it belongs to.
  lastEndedAt = null;
  lastSessionId = null;
  uiLog.info("session/start", { interactionSessionId: sessionId, idx: 0 });
  armIdleTimer();
  return sessionId;
}

/**
 * The live session id, or null when no visit is in progress.
 *
 * Read by the wake-photo upload so each burst frame carries the session it
 * belongs to. Null is a legitimate answer (dimming disabled, plain browser) ,
 * the upload path treats it as "unattributed", never as an error.
 */
export function currentInteractionSessionId(): string | null {
  return sessionId;
}

/** Test seam: drop all session state so cases don't bleed into each other. */
export function __resetInteractionSessionForTests(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  sessionId = null;
  sessionIdx = 0;
  sessionStartedAt = 0;
  lastEndedAt = null;
  lastSessionId = null;
}
