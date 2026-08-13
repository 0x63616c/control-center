import {
  CLIMATE_DEVICE_ID,
  type DeviceClimateState,
  DeviceKind,
  type DeviceLightState,
  type DeviceStateStore,
  type deviceState,
  FIXTURE_ENTITY_IDS,
  findLight,
  HaError,
  isClimateState,
  LAMP_ENTITY_IDS,
  type LightColor,
  type LightEntry,
  LightKind,
  mergeDeviceState,
  rgbToXy,
} from "@www/core";
import { getLogger } from "@www/logger";
import { eq } from "drizzle-orm";
import { db, deviceStateStore } from "./db";
import { ha } from "./deps";
import {
  assignMoodColors,
  BLUE_RGB,
  LampMode,
  type LampModeSpeed,
  LampScene,
  MOOD_PALETTE,
  RED_RGB,
  WHITE_SCENE_KELVIN,
} from "./lamp-scenes";
import { LAMP_MODE_SINGLETON_ID, lampMode } from "./schema";

// ─── types ───────────────────────────────────────────────────────────────────

interface LampState {
  on: boolean;
  /** Number of lamp entities currently on. */
  count: number;
  /** Average brightness (0..100, rounded) across on-lamps; 0 when none on. */
  brightness: number;
  /** Sub-label. Always "On" or "Off" , no count or warmth. */
  sub: string;
  pending: boolean;
  /**
   * The active lamp scene. "party" (and any future animated mode) when the
   * lamp_mode row is set; otherwise the color scene every on-lamp agrees on,
   * derived from DESIRED colors (white/red/blue, or mood when every lamp shows
   * a MOOD_PALETTE color, www-vhht). null when no mode is set and lamps
   * disagree, are off, or show a custom color (www-7d5b.3.4).
   */
  activeScene: ActiveScene | null;
}

/**
 * The active lamp scene reported to the UI: one of the color scenes, or an
 * animated lamp mode (currently just "party"). Never "none" , that maps to
 * "no mode set", which falls through to the color-derived scene or null.
 */
type ActiveScene = LampScene | typeof LampMode.Party;

interface LightState {
  on: boolean;
  pending: boolean;
}

interface FanState {
  on: boolean;
  /** Sub-label, e.g. "Medium". */
  sub: string;
  pending: boolean;
}

export interface ControlsState {
  lamps: LampState;
  lights: LightState;
  fan: FanState;
}

export const ControlKey = {
  Lamps: "lamps",
  Lights: "lights",
  Fan: "fan",
} as const;
export type ControlKey = (typeof ControlKey)[keyof typeof ControlKey];

export const FanMode = {
  On: "on",
  Auto: "auto",
} as const;
export type FanMode = (typeof FanMode)[keyof typeof FanMode];

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Convert an HA raw brightness (0..255) to a rounded 0..100 pct. */
function brightnessRawToPct(raw: number | undefined): number {
  if (typeof raw !== "number") return 0;
  return Math.round((raw / 255) * 100);
}

/** Convert a 0..100 pct to HA raw brightness (0..255), clamped. */
function brightnessPctToRaw(pct: number): number {
  const clamped = Math.min(100, Math.max(0, pct));
  return Math.round((clamped / 100) * 255);
}

/**
 * The "fan" is the AC's climate fan_mode, not a fan.* device (evee parity). It is
 * desired-authoritative now (www-unxz.2): the dashboard writes desired.fanMode on
 * the climate device_state row and the climate enforcer pushes it to HA. So the
 * fan is read from the climate row's desired (with reported as the convergence
 * base for `pending`), exactly like the lamps/lights , NO live HA fan read.
 */
interface FanEffective {
  on: boolean;
  sub: string;
  pending: boolean;
}

/** Derive the fan view from the climate device_state row (desired-authoritative). */
function effectiveFan(row: typeof deviceState.$inferSelect | undefined): FanEffective {
  if (!row) return { on: false, sub: "", pending: false };
  const merged = mergeDeviceState(row);
  const state = isClimateState(merged.state) ? merged.state : null;
  const fanMode = state?.fanMode ?? null;
  const on = fanMode === FanMode.On;
  // Label (www-pu4m): "On" for continuous circulation; otherwise "auto" only means
  // something while the AC is running , when the AC mode is off the fan is doing
  // nothing, so surface it honestly as "Off" rather than "Auto".
  let sub = "";
  if (on) sub = "On";
  else if (state?.mode === "off") sub = "Off";
  else if (fanMode === FanMode.Auto) sub = "Auto";
  // pending is true only while the SPECIFIED desired fanMode hasn't converged with
  // reported. An absent desired fanMode means no fan intent → never pending.
  const desired = isClimateState(row.desiredState) ? row.desiredState : null;
  const reported = isClimateState(row.reportedState) ? row.reportedState : null;
  const pending = desired?.fanMode != null && (reported?.fanMode ?? null) !== desired.fanMode;
  return { on, sub, pending };
}

// ─── desired-authoritative effective state ────────────────────────────────────

/** The effective (desired-authoritative) view of one managed light. */
interface EffectiveLight {
  /** Painted-on only when reachable AND effective state is on. */
  on: boolean;
  /** Effective desired/reported state (null when no row yet). */
  state: DeviceLightState | null;
  available: boolean;
  pending: boolean;
}

/**
 * Resolve a managed light's effective state from its device_state row. Desired is
 * authoritative (mergeDeviceState); availability is honest , an unreachable light
 * is never painted "on" even if desired says so (repo ZERO-fake-data rule). A
 * device with no row yet is treated as unavailable (not painted).
 */
function effectiveLight(row: typeof deviceState.$inferSelect | undefined): EffectiveLight {
  if (!row) return { on: false, state: null, available: false, pending: false };
  const merged = mergeDeviceState(row);
  const state = (merged.state as DeviceLightState | null) ?? null;
  const on = merged.available && (state?.on ?? false);
  return { on, state, available: merged.available, pending: merged.pending };
}

// ─── activeScene derivation (from desired colors) ────────────────────────────

function rgbEquals(a: readonly number[] | undefined, b: readonly number[]): boolean {
  return !!a && a.length === 3 && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function xyEquals(a: readonly number[] | undefined, b: readonly number[]): boolean {
  return !!a && a.length === 2 && a[0] === b[0] && a[1] === b[1];
}

const RED_XY = rgbToXy(RED_RGB);
const BLUE_XY = rgbToXy(BLUE_RGB);
const MOOD_XY = MOOD_PALETTE.map(rgbToXy);

/** Map one desired color to the scene it represents, or null. Exact compare ,
 *  these are our OWN written values, so no HA round-trip tolerance is needed.
 *  A MOOD_PALETTE color maps to Mood (www-vhht): mood writes a distinct palette
 *  color per lamp, so per-lamp palette membership is the mood signature ,
 *  RED_RGB/BLUE_RGB are deliberately absent from the palette, so no ambiguity. */
function colorToScene(color: LightColor | undefined): LampScene | null {
  if (!color) return null;
  if (color.kelvin === WHITE_SCENE_KELVIN) return LampScene.White;
  if (xyEquals(color.xy, RED_XY) || rgbEquals(color.rgb, RED_RGB)) return LampScene.Red;
  if (xyEquals(color.xy, BLUE_XY) || rgbEquals(color.rgb, BLUE_RGB)) return LampScene.Blue;
  if (
    MOOD_XY.some((xy) => xyEquals(color.xy, xy)) ||
    MOOD_PALETTE.some((rgb) => rgbEquals(color.rgb, rgb))
  ) {
    return LampScene.Mood;
  }
  return null;
}

/**
 * Derive the active scene from the desired colors of the on-lamps. Every on-lamp
 * must agree on the same scene; otherwise null (lamps off, mixed or custom
 * colors). Mood counts as agreement: every lamp shows some MOOD_PALETTE color
 * (they differ per lamp by design, www-vhht). The party mode overrides this from
 * the lamp_mode row (added in www-7d5b.3.4 via deriveActiveScene's caller).
 */
function deriveSceneFromDesired(onLampStates: (DeviceLightState | null)[]): LampScene | null {
  if (onLampStates.length === 0) return null;
  let scene: LampScene | null = null;
  for (const state of onLampStates) {
    const s = colorToScene(state?.color);
    if (s === null) return null;
    if (scene === null) scene = s;
    else if (scene !== s) return null;
  }
  return scene;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Fetch the current state of all controllable entities: lamps, lights, fan.
 *
 * DESIRED-authoritative (www-7d5b.2.4, www-unxz.2): lamp/light/fan state all come
 * from the device_state DESIRED state (the source of truth the enforcers reconcile
 * onto HA), so the panel reads its own intent with no snap-back. The fan is the
 * climate row's desired.fanMode (no live HA read). Availability is read honestly
 * from the row , an unreachable light is never painted "on".
 *
 * Throws when HA is unconfigured so the tile shimmers via the tRPC error state
 * (www-355t.30; the repo-wide THROW-on-unavailable convention).
 */
export async function getControlsState(
  store: DeviceStateStore = deviceStateStore,
): Promise<ControlsState> {
  if (!ha.isConfigured()) {
    throw new HaError(0, "Home Assistant is not configured");
  }

  // Lamp/light/fan state is all read from device_state (desired-authoritative).
  let deviceRows: (typeof deviceState.$inferSelect)[] = [];
  try {
    deviceRows = await store.list();
  } catch (err) {
    // DB unreachable , no rows; every managed device reads unavailable (shimmer).
    getLogger().warn({ err }, "getControlsState: DB read failed, devices appear unavailable");
  }
  const rowByEntityId = new Map(deviceRows.map((r) => [r.entityId, r]));
  const rowById = new Map(deviceRows.map((r) => [r.id, r]));

  const lampEffectives = LAMP_ENTITY_IDS.map((id) => effectiveLight(rowByEntityId.get(id)));
  const fixtureEffectives = FIXTURE_ENTITY_IDS.map((id) => effectiveLight(rowByEntityId.get(id)));

  const lampsOn = lampEffectives.filter((e) => e.on);
  const anyLampOn = lampsOn.length > 0;
  // Brightness drives the modal's level bar. When lamps are ON it is the avg live
  // level of the on-lamps. When ALL lamps are OFF we report the avg last-known
  // DESIRED level (which persists across a toggle) so the bar keeps its fill and
  // the frontend grays it out, instead of dropping to 0% (www-91bl). Only a truly
  // unknown level (no lamp has any brightness) falls back to 0 (an empty bar).
  const brightnessSource = anyLampOn
    ? lampsOn
    : lampEffectives.filter((e) => typeof e.state?.brightness === "number");
  const avgBrightness =
    brightnessSource.length > 0
      ? Math.round(
          brightnessSource.reduce((sum, e) => sum + brightnessRawToPct(e.state?.brightness), 0) /
            brightnessSource.length,
        )
      : 0;

  const anyLightOn = fixtureEffectives.some((e) => e.on);

  const activeScene = await resolveActiveScene(lampsOn.map((e) => e.state));

  // Fan = the climate row's desired.fanMode (www-unxz.2), desired-authoritative
  // with a real `pending` from desired-vs-reported convergence.
  const fan = effectiveFan(rowById.get(CLIMATE_DEVICE_ID));

  return {
    lamps: {
      on: anyLampOn,
      count: lampsOn.length,
      brightness: avgBrightness,
      sub: anyLampOn ? "On" : "Off",
      // Lamps are desired-authoritative and NEVER report pending (www-uq58). The
      // panel already paints desired instantly, and the Hue rgb/kelvin reported
      // rarely converges to desired within tolerance (www-bujt.7), so a real
      // pending flag would stick on forever as a stuck dim. Only the fan keeps a
      // pending cue (a genuine HA fan_mode convergence).
      pending: false,
      activeScene,
    },
    lights: {
      on: anyLightOn,
      // Desired-authoritative, never pending , same rationale as lamps (www-uq58).
      pending: false,
    },
    fan,
  };
}

/**
 * Resolve the active scene. The persistent lamp_mode row wins: a non-"none" mode
 * (e.g. "party") is reported directly , the animation is owned by the worker, so
 * the API can't read it from memory and must take it from the DB row (www-7d5b.3.4).
 * Otherwise it falls back to the color scene the on-lamps' desired colors agree
 * on (www-7d5b.2.4).
 */
async function resolveActiveScene(
  onLampStates: (DeviceLightState | null)[],
): Promise<ActiveScene | null> {
  const mode = await readLampMode();
  if (mode !== LampMode.None) return mode;
  return deriveSceneFromDesired(onLampStates);
}

/**
 * Clear any persistent lamp mode (upsert the singleton row to "none"). The party
 * worker OWNS the color dimension while mode=party (the enforcer yields color to
 * it), so an explicit manual color/scene command must end party , otherwise the
 * animation keeps overwriting the user's color every tick and the scene never
 * sticks. Turning the lamps OFF clears it too, so party never silently resurrects
 * on the next lamp-on (www-hu8p). DB-unreachable is swallowed: the scene/toggle
 * actuation still fires, so the command is never a silent no-op.
 */
async function clearLampMode(): Promise<void> {
  const now = new Date();
  try {
    await db
      .insert(lampMode)
      .values({ id: LAMP_MODE_SINGLETON_ID, mode: LampMode.None, speed: null, updatedAtUtc: now })
      .onConflictDoUpdate({
        target: lampMode.id,
        set: { mode: LampMode.None, speed: null, updatedAtUtc: now },
      });
  } catch {
    // DB unreachable , mode can't be cleared; the actuation below still fires.
  }
}

/** Read the persistent lamp_mode (the singleton row); "none" when absent/unreadable. */
async function readLampMode(): Promise<LampMode> {
  try {
    const rows = await db
      .select({ mode: lampMode.mode })
      .from(lampMode)
      .where(eq(lampMode.id, LAMP_MODE_SINGLETON_ID))
      .limit(1);
    const mode = rows[0]?.mode;
    return mode === LampMode.Party ? LampMode.Party : LampMode.None;
  } catch {
    return LampMode.None;
  }
}

// ─── desired-state writes ──────────────────────────────────────────────────────

/**
 * Upsert the desired state for a set of managed lights. Desired is STICKY (no
 * expiry) , it is the source of truth the enforcer continuously reconciles.
 * `mutate` derives the new desired from the existing one (so a brightness change
 * keeps the color, a toggle keeps the scene).
 *
 * Each write also stamps a short `desiredUntilUtc` COMMAND WINDOW (www-unxz.1):
 * the mutations no longer actuate HA themselves, so the enforcer must PUSH this
 * freshly-set desired regardless of control policy until it converges or the
 * window expires. Without it an `adopt` fixture (a wall-switch) would revert a
 * just-issued tap on the very next enforcer cycle. After the window, `control`
 * governs unsolicited drift as before.
 */
async function writeDesired(
  entries: LightEntry[],
  mutate: (entry: LightEntry, prev: DeviceLightState | null) => DeviceLightState,
  store: DeviceStateStore,
): Promise<void> {
  if (entries.length === 0) return;

  let rows: (typeof deviceState.$inferSelect)[] = [];
  try {
    rows = await store.list({ entityIds: entries.map((e) => e.entityId) });
  } catch {
    rows = [];
  }
  const rowByEntityId = new Map(rows.map((r) => [r.entityId, r]));

  await Promise.all(
    entries.map(async (entry) => {
      const prev =
        (rowByEntityId.get(entry.entityId)?.desiredState as DeviceLightState | null) ?? null;
      const desired = mutate(entry, prev);
      // The store owns the command-window stamp and throws on DB failure , a
      // swallowed write would be fabricated success (www-unxz.1). The error
      // propagates to the tRPC layer, which maps it.
      await store.upsertDesired({
        id: entry.id,
        kind: entry.kind === LightKind.Lamp ? DeviceKind.Light : DeviceKind.Switch,
        entityId: entry.entityId,
        domain: entry.domain,
        label: entry.label,
        desired,
      });
    }),
  );
}

/**
 * Write the fan_mode intent onto the climate row's DESIRED (+ command window),
 * preserving the existing mode/setpoints (www-unxz.2). The climate enforcer pushes
 * the new desired to HA , no ha.callService here. The write goes through the
 * desired-state store, which throws on DB failure (a swallowed write is fabricated
 * success); the error propagates to the tRPC layer. A not-yet-seeded climate row
 * throws "no climate state" (parity with the other climate mutations) , you cannot
 * command a thermostat the enforcer has not yet seen.
 */
async function writeFanDesired(fanMode: FanMode, store: DeviceStateStore): Promise<void> {
  const row = await store.read(CLIMATE_DEVICE_ID);
  if (!row) throw new Error("no climate state");
  const prev = isClimateState(row.desiredState) ? row.desiredState : null;
  const reported = isClimateState(row.reportedState) ? row.reportedState : null;
  const base: DeviceClimateState = prev ?? reported ?? { mode: "off" };
  const desired: DeviceClimateState = { ...base, fanMode };
  await store.updateDesired({ id: row.id, desired });
}

/** All lamp LightEntry rows in LAMP_ENTITY_IDS order. */
function lampEntries(): LightEntry[] {
  return LAMP_ENTITY_IDS.map((id) => findLight(id)).filter((e): e is LightEntry => !!e);
}

/** All fixture LightEntry rows in FIXTURE_ENTITY_IDS order. */
function fixtureEntries(): LightEntry[] {
  return FIXTURE_ENTITY_IDS.map((id) => findLight(id)).filter((e): e is LightEntry => !!e);
}

// ─── mutations (write desired; the enforcer actuates HA) ──────────────────────

/**
 * Toggle lamps, lights, or fan on or off.
 *
 * For lamps/lights: writes the on/off intent to device_state DESIRED (+ a command
 * window) and returns , it does NOT actuate HA in the hot path. The light enforcer
 * pushes desired→HA within its ~1s cycle (it pushes regardless of policy while the
 * command window is open, so even an `adopt` wall-switch honors the tap). Turning
 * a lamp ON preserves its existing desired color/brightness (the scene survives a
 * toggle). Fan stays the climate fan_mode path (evee parity). Throws when HA is
 * unconfigured. Returns the desired-authoritative state.
 */
export async function toggleControl(
  key: ControlKey,
  on: boolean,
  store: DeviceStateStore = deviceStateStore,
): Promise<ControlsState> {
  if (!ha.isConfigured()) {
    throw new HaError(0, "Home Assistant is not configured");
  }

  switch (key) {
    case ControlKey.Lamps: {
      // Turning the lamps OFF ends party , otherwise the row persists and party
      // silently resurrects on the next lamp-on (www-hu8p). ON leaves the mode
      // intact so a durable party re-arms when the lamps come back.
      if (!on) await clearLampMode();
      const entries = lampEntries();
      // Toggle ON preserves the existing desired color/brightness (scene survives
      // a toggle); OFF just flips on. The desired write is the source of truth; the
      // enforcer pushes it to HA within the command window.
      await writeDesired(
        entries,
        (_entry, prev) => (on ? { ...prev, on: true } : { ...(prev ?? {}), on: false }),
        store,
      );
      break;
    }

    case ControlKey.Lights: {
      const entries = fixtureEntries();
      await writeDesired(entries, () => ({ on }), store);
      break;
    }

    case ControlKey.Fan: {
      // Desired-authoritative (www-unxz.2): write the fan_mode intent onto the
      // climate row's desired (+ command window); the climate enforcer pushes it
      // to HA. No ha.callService in the hot path.
      await writeFanDesired(on ? FanMode.On : FanMode.Auto, store);
      break;
    }
  }

  return getControlsState(store);
}

/**
 * Per-lamp desired color for a scene. white/red/blue are uniform; mood assigns
 * each lamp a UNIQUE random palette color (different every call). Returned in
 * LAMP_ENTITY_IDS order so it lines up with the lamp entries.
 */
function sceneColors(scene: LampScene): LightColor[] {
  if (scene === LampScene.Mood) {
    return assignMoodColors(LAMP_ENTITY_IDS.length).map((rgb) => ({ xy: rgbToXy(rgb) }));
  }
  if (scene === LampScene.White) {
    return LAMP_ENTITY_IDS.map(() => ({ kelvin: WHITE_SCENE_KELVIN }));
  }
  const rgb = scene === LampScene.Red ? RED_RGB : BLUE_RGB;
  return LAMP_ENTITY_IDS.map(() => ({ xy: rgbToXy(rgb) }));
}

/**
 * Apply a color scene to every lamp: writes the color into device_state DESIRED
 * (on=true) AND actuates HA immediately. activeScene then reflects the scene from
 * desired , including "mood", where each lamp gets a distinct random palette
 * color and palette membership is the signature (www-vhht). Throws when HA is
 * unconfigured.
 */
export async function setLampScene(
  scene: LampScene,
  store: DeviceStateStore = deviceStateStore,
): Promise<ControlsState> {
  if (!ha.isConfigured()) {
    throw new HaError(0, "Home Assistant is not configured");
  }

  // A manual scene is an explicit color intent , end party so its worker stops
  // overwriting the scene's color every animation tick (www-hu8p).
  await clearLampMode();

  const entries = lampEntries();
  const colors = sceneColors(scene);
  // entries are in LAMP_ENTITY_IDS order, so colors[i] lines up with entries[i].
  const colorByEntity = new Map(entries.map((entry, i) => [entry.entityId, colors[i]]));

  await writeDesired(
    entries,
    (entry) => ({
      on: true,
      color: colorByEntity.get(entry.entityId),
    }),
    store,
  );

  return getControlsState(store);
}

/**
 * Set brightness (0..100 %) on every lamp: writes brightness into device_state
 * DESIRED (on=true, preserving each lamp's existing color) AND actuates HA. The
 * pct is clamped. Throws when HA is unconfigured.
 */
export async function setLampBrightness(
  pct: number,
  store: DeviceStateStore = deviceStateStore,
): Promise<ControlsState> {
  if (!ha.isConfigured()) {
    throw new HaError(0, "Home Assistant is not configured");
  }

  const raw = brightnessPctToRaw(pct);
  const entries = lampEntries();

  await writeDesired(
    entries,
    (_entry, prev) => ({
      on: true,
      brightness: raw,
      ...(prev?.color ? { color: prev.color } : {}),
    }),
    store,
  );

  return getControlsState(store);
}

/**
 * Set the persistent lamp mode (www-7d5b.3.4). Writes the lamp_mode singleton row
 * ({ mode, speed }); the party WORKER reconciles that row (start/stop the color
 * animation), so this only records intent , it does NOT drive HA itself. Starting
 * party with NO lamps currently on is a no-op (nothing to animate; the row stays
 * "none"). Throws when HA is unconfigured (parity with the other mutations, so the
 * tile surfaces the same error). Returns the desired-authoritative state.
 */
export async function setLampMode(
  mode: LampMode,
  speed?: LampModeSpeed,
  store: DeviceStateStore = deviceStateStore,
): Promise<ControlsState> {
  if (!ha.isConfigured()) {
    throw new HaError(0, "Home Assistant is not configured");
  }

  // Starting party with no lamps on has nothing to animate , leave the row as-is.
  if (mode === LampMode.Party && !(await anyLampCurrentlyOn(store))) {
    return getControlsState(store);
  }

  const now = new Date();
  try {
    await db
      .insert(lampMode)
      .values({ id: LAMP_MODE_SINGLETON_ID, mode, speed: speed ?? null, updatedAtUtc: now })
      .onConflictDoUpdate({
        target: lampMode.id,
        set: { mode, speed: speed ?? null, updatedAtUtc: now },
      });
  } catch {
    // DB unreachable , the mode cannot be recorded; surface current state anyway.
  }

  return getControlsState(store);
}

/** True when at least one lamp's effective (desired-authoritative) state is on. */
async function anyLampCurrentlyOn(store: DeviceStateStore): Promise<boolean> {
  let rows: (typeof deviceState.$inferSelect)[] = [];
  try {
    rows = await store.list({ entityIds: [...LAMP_ENTITY_IDS] });
  } catch {
    return false;
  }
  const byEntityId = new Map(rows.map((r) => [r.entityId, r]));
  return LAMP_ENTITY_IDS.some((id) => effectiveLight(byEntityId.get(id)).on);
}
