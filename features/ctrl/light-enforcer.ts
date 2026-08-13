/**
 * DB-authoritative light enforcer (www-7d5b.2.3).
 *
 * Desired state is the source of truth; HA is an actuator. Each cycle this
 * reconciles every managed light's desired vs HA-reported state and, on
 * steady-state divergence, branches on the device's `control` policy:
 *   enforce → push desired back onto HA (Hue lamps win, so scenes/party persist)
 *   adopt   → set desired = reported (absorb the external change; switch fixtures
 *             with real wall switches keep working , never fought)
 * Seeding: a device whose desired is null copies reported → desired once (adopt
 * reality on first sight; no push). Writes hit HA ONLY on drift, and only for
 * enforce. Unreachable devices are marked unavailable and otherwise left alone.
 *
 * This replaces the old device-sync snap-to-HA reconcile for LIGHTS. Drift uses a
 * TOLERANT compare (not the exact stateEquals, which is for reported-change
 * detection) because HA round-trips rgb/kelvin/brightness with small deltas.
 */

import {
  type DeviceLightState,
  type DeviceStateStore,
  findLight,
  type HaEntity,
  HaLightService,
  heartbeat,
  isLightState,
  LIGHTS,
  type LightColor,
  LightControl,
  LightKind,
  lightControl,
  type MappedHaState,
  mapHaToReported,
  runCycle,
  windowOpen,
} from "@www/core";
import { getLogger, logChange } from "@www/logger";
import { eq } from "drizzle-orm";
import { db, deviceStateStore, integrationSyncStore } from "./db";
import { ha } from "./deps";
import { LampMode } from "./lamp-scenes";
import { LAMP_MODE_SINGLETON_ID, lampMode } from "./schema";

const ENFORCER_INTEGRATION_ID = "light-enforcer";
const ENFORCER_DOMAINS = ["light", "switch"] as const;

// Drift tolerances. HA does not round-trip color/brightness exactly (e.g. it
// reports [0,0,255] back as [0,2,254]); a per-channel/absolute slack stops the
// enforcer from fighting its own writes forever. Tuned per team-lead's guidance.
const RGB_CHANNEL_TOLERANCE = 12;
const XY_COMPONENT_TOLERANCE = 0.005;
const KELVIN_TOLERANCE = 250;
const BRIGHTNESS_TOLERANCE = 3;

// Entity ids the enforcer manages: every LIGHTS entry (lamps + fixtures).
const MANAGED_ENTITY_IDS: readonly string[] = LIGHTS.map((l) => l.entityId);

/** True when two colors are within HA round-trip tolerance (or both absent). */
function colorConverged(a: LightColor | undefined, b: LightColor | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  // A device is in one color mode at a time; rgb-vs-kelvin is a real divergence.
  const aKelvin = a.kelvin != null;
  const bKelvin = b.kelvin != null;
  if (aKelvin !== bKelvin) return false;
  if (aKelvin && bKelvin) return Math.abs((a.kelvin ?? 0) - (b.kelvin ?? 0)) <= KELVIN_TOLERANCE;
  const axy = a.xy;
  const bxy = b.xy;
  if (axy || bxy) {
    if (!axy || !bxy) return false;
    return axy.every(
      (component, index) => Math.abs(component - bxy[index]) <= XY_COMPONENT_TOLERANCE,
    );
  }
  const ar = a.rgb;
  const br = b.rgb;
  if (!ar || !br) return !ar && !br;
  return ar.every((c, i) => Math.abs(c - br[i]) <= RGB_CHANNEL_TOLERANCE);
}

/**
 * Tolerant desired-vs-reported convergence check used for DRIFT detection. On/off
 * must match exactly; brightness and color within tolerance. (Exact equality is
 * stateEquals in ha-mapping, used for reported-change detection.)
 */
export function lightStateConverged(
  desired: DeviceLightState,
  reported: DeviceLightState,
): boolean {
  if (desired.on !== reported.on) return false;
  // When the light is off, brightness/color are irrelevant , off is off.
  if (!desired.on) return true;
  const desiredBrightness = desired.brightness;
  const reportedBrightness = reported.brightness;
  if (
    desiredBrightness != null &&
    reportedBrightness != null &&
    Math.abs(desiredBrightness - reportedBrightness) > BRIGHTNESS_TOLERANCE
  ) {
    return false;
  }
  return colorConverged(desired.color, reported.color);
}

// A device row as the reconciler needs it (subset of the deviceState row).
interface ManagedDevice {
  id: string;
  entityId: string;
  domain: string;
  control: LightControl;
  desiredState: DeviceLightState | null;
  // App-command window: while now < desiredUntilUtc the freshly-set desired is
  // pushed regardless of policy (the command owns the transition). null = no
  // open window (www-unxz.1).
  desiredUntilUtc: Date | null;
}

export type EnforcementDecision =
  | { kind: "noop" }
  | { kind: "unreachable" }
  | { kind: "seed"; desired: DeviceLightState }
  | { kind: "adopt"; desired: DeviceLightState }
  | { kind: "push"; desired: DeviceLightState };

/**
 * Pure reconcile decision for one device. No I/O , the cycle executes the result.
 * `partyActive` makes the enforcer YIELD COLOR to the party engine for lamps
 * (www-7d5b.3.3): on/off is still enforced (so the wave stays lit), but a
 * color-only divergence is ignored so the 1s enforcer never fights the
 * animation. Switch fixtures have no color, so party is a no-op for them.
 *
 * The app-command window (www-unxz.1): the control mutations no longer push to HA
 * themselves , they write desired + a short `desiredUntilUtc` and return. So on
 * drift while inside that window we PUSH the desired regardless of policy (the
 * command owns the transition until it converges or the window expires). Only
 * after the window does `control` govern unsolicited drift (enforce → push,
 * adopt → absorb). This window REPLACES the old `device_commands` in-flight gate
 * (www-unxz hotfix): that dead command-queue table left stale `sent` rows that
 * permanently no-op'd the enforcer, so the enforcer no longer consults it.
 */
export function decideEnforcement(
  device: ManagedDevice,
  mapped: MappedHaState,
  partyActive = false,
  now: Date = new Date(),
): EnforcementDecision {
  // Unreachable: can't read truth, so can't enforce or adopt. Caller flips
  // available=false; desired is left untouched (intent survives the outage).
  // The light enforcer only manages light/switch entities, so reported is always a
  // light state; a non-light (or absent) reading means we can't read truth.
  if (!mapped.available || !isLightState(mapped.reported)) return { kind: "unreachable" };
  const reported = mapped.reported;

  // Seed once: adopt current reality as the initial intent without pushing.
  if (device.desiredState == null) return { kind: "seed", desired: reported };

  // Steady state: only act on genuine drift. While party is active the party
  // engine owns color, so compare on/off only (yield color); otherwise full
  // tolerant compare.
  const converged = partyActive
    ? device.desiredState.on === reported.on
    : lightStateConverged(device.desiredState, reported);
  if (converged) return { kind: "noop" };

  // Inside the app-command window: the freshly-set desired wins regardless of
  // policy until it converges or the window expires.
  if (windowOpen(device, now)) return { kind: "push", desired: device.desiredState };

  return lightControl(device) === LightControl.Enforce
    ? { kind: "push", desired: device.desiredState }
    : { kind: "adopt", desired: reported };
}

/** Build `light.turn_on` params from a desired state (brightness is HA raw 0..255). */
function buildTurnOnParams(entityId: string, desired: DeviceLightState): Record<string, unknown> {
  const params: Record<string, unknown> = { entity_id: entityId };
  if (desired.brightness != null) params.brightness = desired.brightness;
  if (desired.color?.xy) params.xy_color = desired.color.xy;
  else if (desired.color?.rgb) params.rgb_color = desired.color.rgb;
  else if (desired.color?.kelvin != null) params.color_temp_kelvin = desired.color.kelvin;
  if (desired.transitionSeconds != null) params.transition = desired.transitionSeconds;
  return params;
}

export async function runEnforcerCycle(store: DeviceStateStore = deviceStateStore): Promise<void> {
  await runCycle(
    heartbeat(integrationSyncStore, ENFORCER_INTEGRATION_ID),
    "light-enforcer",
    async () => {
      const snapshot = await fetchSnapshot();
      await reconcile(snapshot, store);
    },
  );
}

async function fetchSnapshot(): Promise<Map<string, HaEntity>> {
  const lists = await Promise.all(ENFORCER_DOMAINS.map((d) => ha.getEntities(d)));
  const byEntityId = new Map<string, HaEntity>();
  for (const list of lists) for (const e of list) byEntityId.set(e.entity_id, e);
  return byEntityId;
}

async function reconcile(snapshot: Map<string, HaEntity>, store: DeviceStateStore): Promise<void> {
  const rows = await store.list({ entityIds: MANAGED_ENTITY_IDS });
  const now = new Date();
  // While party mode is active the party engine owns lamp COLOR; the enforcer
  // yields color (but still enforces on/off) so the two don't fight (www-7d5b.3.3).
  const partyActive = await isPartyActive();

  for (const row of rows) {
    const entry = findLight(row.entityId);
    if (!entry) continue; // not a managed light (defensive)

    const entity = snapshot.get(row.entityId);
    const mapped = mapHaToReported(row.kind, entity);

    const device: ManagedDevice = {
      id: row.id,
      entityId: row.entityId,
      domain: row.domain,
      control: lightControl(entry),
      desiredState: isLightState(row.desiredState) ? row.desiredState : null,
      desiredUntilUtc: row.desiredUntilUtc ?? null,
    };

    // Color-yield applies only to lamps (light domain); switch fixtures have no
    // color, so party never affects them.
    const yieldColor = partyActive && entry.kind === LightKind.Lamp;
    const decision = decideEnforcement(device, mapped, yieldColor, now);
    await applyDecision(device, decision, mapped, now, store);
  }
}

/** True when the lamp_mode singleton row is in party mode. */
async function isPartyActive(): Promise<boolean> {
  const rows = await db
    .select({ mode: lampMode.mode })
    .from(lampMode)
    .where(eq(lampMode.id, LAMP_MODE_SINGLETON_ID))
    .limit(1);
  return rows[0]?.mode === LampMode.Party;
}

async function applyDecision(
  device: ManagedDevice,
  decision: EnforcementDecision,
  mapped: MappedHaState,
  now: Date,
  store: DeviceStateStore,
): Promise<void> {
  const available = mapped.available;
  // The enforcer is the sole owner of lamp state now (device-sync is fan-only),
  // so it MUST persist reportedState every cycle , getControlsState reads it as
  // the overlay base (desired fields override, reported fills the rest). Without
  // this, reported goes stale → the panel reads brightness 0 / no scene / stuck
  // pending (www-7d5b.2.4 follow-up).

  switch (decision.kind) {
    case "unreachable": {
      // Honest availability for the UI; never paint desired as real when down.
      await store.writeReported({
        id: device.id,
        reported: mapped.reported,
        available: false,
        now,
      });
      return;
    }
    case "seed":
    case "adopt": {
      // Both write desired (and refresh availability); neither pushes to HA.
      if (decision.kind === "adopt") {
        // Log the absorbed state so we can see external drift that we accepted.
        // logChange, not a raw info: this runs on a 1s loop, so only a CHANGE in
        // what we adopted is an event (docs/logging.md §3).
        logChange(
          getLogger(),
          `light-adopt:${device.entityId}`,
          {
            entityId: device.entityId,
            adoptedOn: decision.desired.on,
            adoptedBrightness: decision.desired.brightness,
            adoptedColor: decision.desired.color,
          },
          "light-enforcer adopted reported state",
        );
      }
      await store.writeReported({
        id: device.id,
        reported: mapped.reported,
        available,
        adoptDesired: decision.desired,
        now,
      });
      return;
    }
    case "push": {
      // Re-assert desired onto HA. on→turn_on (with brightness/color); off→turn_off.
      // logChange, not a raw info: a light that never converges (HA ignoring us,
      // bulb offline mid-window) is pushed again every second, which at info
      // would be ~86k lines/day for one stuck bulb. The first push is the event;
      // the identical follow-ups are counted into `repeats` and re-announced
      // every 15 min so a stuck enforcer is loud but not a flood.
      logChange(
        getLogger(),
        `light-push:${device.entityId}`,
        {
          entityId: device.entityId,
          on: decision.desired.on,
          brightness: decision.desired.brightness,
          // Color logged as kelvin or rgb tuple , never a raw object that could
          // contain unexpected fields. Never logs HA_TOKEN or auth headers.
          color:
            decision.desired.color?.kelvin != null
              ? { kelvin: decision.desired.color.kelvin }
              : decision.desired.color?.xy != null
                ? { xy: decision.desired.color.xy }
                : decision.desired.color?.rgb != null
                  ? { rgb: decision.desired.color.rgb }
                  : undefined,
        },
        "light-enforcer pushing desired to HA",
      );
      if (decision.desired.on) {
        await ha.callService(
          device.domain,
          HaLightService.TurnOn,
          buildTurnOnParams(device.entityId, decision.desired),
        );
      } else {
        await ha.callService(device.domain, HaLightService.TurnOff, {
          entity_id: device.entityId,
          ...(decision.desired.transitionSeconds != null
            ? { transition: decision.desired.transitionSeconds }
            : {}),
        });
      }
      await store.writeReported({ id: device.id, reported: mapped.reported, available, now });
      return;
    }
    case "noop": {
      // Refresh reported + availability.
      await store.writeReported({ id: device.id, reported: mapped.reported, available, now });
      return;
    }
  }
}
