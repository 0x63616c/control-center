/**
 * DB-authoritative climate enforcer (www-unxz.2).
 *
 * Mirrors the light enforcer for the single house thermostat
 * (`config.CLIMATE_ENTITY_ID`). `device_state.desiredState` is the source of truth
 * for the AC's commandable fields (hvac mode, setpoint(s), fan_mode); HA is an
 * actuator. The AC's control policy is ADOPT (www-qktc) , the thermostat has a
 * physical interface (wall unit + ecobee app) just like the Shelly wall
 * switches, so an external change is absorbed as new intent (desired :=
 * reported), last-writer-wins. Only a fresh dashboard tap, marked by the
 * desiredUntilUtc command window, pushes desired→HA.
 *
 * Each cycle: snapshot HA's climate entities, find the house thermostat, and
 *   - seed desired from reported once when desired is null (no push), then
 *   - on drift INSIDE the command window, PUSH desired→HA (set_hvac_mode +
 *     set_temperature single/range + set_fan_mode as the desired specifies),
 *   - on drift OUTSIDE the window, ADOPT (write desired := reported, no HA call),
 *   - always write reportedState (incl. real ambient + hvac_action) so the panel
 *     reads ≤1s-fresh values with no HA call in the read path,
 *   - heartbeat to integration_sync_status.
 *
 * Ambient temperature and hvac_action are REPORTED-ONLY and always real HA values
 * (repo zero-fake-data rule). Multi-zone climate is out of scope , this enforcer
 * only manages the one configured house thermostat.
 */

import {
  CLIMATE_DEVICE_ID,
  climateSetpointsObservable,
  climateStateConverged,
  DeviceKind,
  type DeviceStateStore,
  heartbeat,
  isActivelyConditioning,
  isClimateState,
  type MappedHaState,
  mapHaToReported,
  rememberedClimateDesired,
  runCycle,
  sanitizeClimateDesired,
  windowOpen,
} from "@www/core";
import { getLogger, logChange } from "@www/logger";
import { ENV as config } from "@www/platform/env";
import { deviceStateStore } from "../db/device-state-store";
import { integrationSyncStore } from "../db/integration-sync-store";
import type { DeviceClimateState } from "../db/schema";
import { ha } from "../integrations/homeassistant";
import type { HaEntity } from "../integrations/homeassistant/types";

const CLIMATE_ENFORCER_INTEGRATION_ID = "climate-enforcer";

// The thermostat row as the reconciler needs it.
interface ManagedClimate {
  id: string;
  entityId: string;
  desiredState: DeviceClimateState | null;
  // The PREVIOUS cycle's reported state. Only used as a setpoint memory when the
  // thermostat goes off (HA then reports no setpoint at all) and desired holds
  // none either , so the next on has the last real number, not 0.
  lastReported?: DeviceClimateState | null;
  // App-command window: while now < desiredUntilUtc the freshly-set desired is
  // the dashboard's explicit intent and is pushed on drift. Outside the window
  // drift is external (wall unit / ecobee app / schedule) and is adopted.
  desiredUntilUtc: Date | null;
}

export type ClimateEnforcementDecision =
  | { kind: "noop" }
  | { kind: "unreachable" }
  | { kind: "seed"; desired: DeviceClimateState }
  | { kind: "push"; desired: DeviceClimateState }
  | { kind: "adopt"; desired: DeviceClimateState };

/**
 * Pure reconcile decision for the thermostat. No I/O , the cycle executes it.
 * Seed once (adopt reality as initial intent, no push); on drift INSIDE the
 * command window push desired (a dashboard tap actuates); on drift OUTSIDE it
 * adopt (desired := reported , an external change is new intent, never fought:
 * www-qktc); otherwise noop. Reported-only ambient/action never count as drift
 * (climateStateConverged ignores them).
 */
export function decideClimateEnforcement(
  device: ManagedClimate,
  mapped: MappedHaState,
  now: Date = new Date(),
): ClimateEnforcementDecision {
  if (!mapped.available || mapped.reported == null || !isClimateState(mapped.reported)) {
    return { kind: "unreachable" };
  }
  const reported = mapped.reported;

  // Seed once: adopt current reality as the initial intent without pushing.
  // Sanitized , desired only ever carries commandable fields; copying the
  // reported-only ambient/action would freeze them in the merge overlay (www-dnpj).
  if (device.desiredState == null) {
    return { kind: "seed", desired: sanitizeClimateDesired(reported) };
  }

  // While the AC is actively heating/cooling it owns its blower and reports
  // fan_mode="on"; a desired fan_mode that disagrees is NOT drift to fight, or we
  // get the on/off/on/off flicker (www-pu4m). Yield the fan dimension then.
  const conditioning = isActivelyConditioning(reported);
  if (climateStateConverged(device.desiredState, reported, { ignoreFan: conditioning })) {
    return { kind: "noop" };
  }

  // Drift outside the command window is EXTERNAL (wall unit / app / schedule):
  // absorb it as the new intent (www-qktc). The adopted desired is the commandable
  // slice of reported; while conditioning the reported fan_mode is the AC
  // asserting its blower (www-pu4m), not intent , keep the prior desired fan.
  if (!windowOpen(device, now)) {
    // Remembered: while the thermostat is off HA reports no setpoints, so the
    // adopted desired keeps the last real ones rather than forgetting them.
    const adopted = rememberedClimateDesired(reported, device.desiredState, device.lastReported);
    if (conditioning) {
      delete adopted.fanMode;
      if (device.desiredState.fanMode != null) adopted.fanMode = device.desiredState.fanMode;
    }
    return { kind: "adopt", desired: adopted };
  }

  // Window open: the drift is a fresh dashboard command , push it. While
  // conditioning, strip fan_mode so we never actuate the blower the AC controls.
  const desired = conditioning
    ? { ...device.desiredState, fanMode: undefined }
    : device.desiredState;
  return { kind: "push", desired };
}

export async function runClimateEnforcerCycle(
  store: DeviceStateStore = deviceStateStore,
): Promise<void> {
  await runCycle(
    heartbeat(integrationSyncStore, CLIMATE_ENFORCER_INTEGRATION_ID),
    "climate-enforcer",
    async () => {
      const entities = await ha.getEntities("climate");
      const entity = entities.find((e) => e.entity_id === config.CLIMATE_ENTITY_ID);
      await reconcileClimate(entity, store);
    },
  );
}

async function reconcileClimate(
  entity: HaEntity | undefined,
  store: DeviceStateStore,
): Promise<void> {
  const now = new Date();
  const row = await store.read(CLIMATE_DEVICE_ID);
  const mapped = mapHaToReported(DeviceKind.Climate, entity);

  // No row yet AND the entity is unreachable: nothing to seed from, nothing to
  // write (we never fabricate a row from thin air). Wait for HA to report.
  if (!row && (!mapped.available || mapped.reported == null)) return;

  // First sight with a reachable entity: seed the row (desired = the
  // commandable slice of reported, no push) so the panel can read immediately.
  // store.seed() stamps reportedAtUtc/desiredAtUtc to `now` itself.
  if (!row) {
    await store.seed({
      id: CLIMATE_DEVICE_ID,
      kind: DeviceKind.Climate,
      entityId: config.CLIMATE_ENTITY_ID,
      domain: "climate",
      label: "Thermostat",
      reported: mapped.reported,
      desired: isClimateState(mapped.reported)
        ? sanitizeClimateDesired(mapped.reported)
        : mapped.reported,
      available: true,
      now,
    });
    return;
  }

  const storedDesired = isClimateState(row.desiredState) ? row.desiredState : null;
  const desired = storedDesired ? sanitizeClimateDesired(storedDesired) : null;
  // Self-heal a pre-fix row whose desired still carries the reported-only
  // ambient/action (www-dnpj): persist the sanitized desired with this cycle's
  // write so the row converges without a manual migration. Routed through
  // writeReported's adoptDesired below (controller-approved deviation): this
  // also bumps desiredAtUtc, which is fine , nothing enforcement-critical
  // reads it (the command window uses desiredUntilUtc), and the heal only
  // fires on pre-fix rows.
  const desiredFix =
    storedDesired != null && (storedDesired.ambient != null || storedDesired.action != null)
      ? sanitizeClimateDesired(storedDesired)
      : undefined;

  const device: ManagedClimate = {
    id: row.id,
    entityId: row.entityId,
    desiredState: desired,
    lastReported: isClimateState(row.reportedState) ? row.reportedState : null,
    desiredUntilUtc: row.desiredUntilUtc ?? null,
  };
  const decision = decideClimateEnforcement(device, mapped, now);
  await applyDecision(device, decision, mapped, now, store, desiredFix);
}

async function applyDecision(
  device: ManagedClimate,
  decision: ClimateEnforcementDecision,
  mapped: MappedHaState,
  now: Date,
  store: DeviceStateStore,
  // www-dnpj self-heal: when the stored desired carried reported-only fields,
  // the sanitized replacement rides along on this cycle's write via
  // adoptDesired (seed/adopt below set their own desired regardless).
  desiredFix: DeviceClimateState | undefined = undefined,
): Promise<void> {
  switch (decision.kind) {
    case "unreachable": {
      // Log the lost thermostat so an outage is visible without a device
      // export. logChange, not a raw info: unreachable holds steady across many
      // cycles while HA is down, so only the transition is the event
      // (docs/logging.md §3).
      logChange(
        getLogger(),
        `climate-unreachable:${device.entityId}`,
        { entityId: device.entityId },
        "climate enforcer lost the thermostat",
      );
      // Honest availability , never paint desired as a real reading when down.
      await store.writeReported({
        id: device.id,
        reported: mapped.reported,
        available: false,
        now,
        ...(desiredFix !== undefined ? { adoptDesired: desiredFix } : {}),
      });
      return;
    }
    case "seed":
    // Adopt persists exactly like seed: desired := the commandable slice of
    // reported, no HA call , an external change became the new intent (www-qktc).
    case "adopt": {
      if (decision.kind === "adopt") {
        // Log the absorbed state so external drift (wall unit / ecobee app /
        // schedule) that we accepted is visible. logChange, not a raw info ,
        // same reasoning as light-enforcer's adopt line (docs/logging.md §3).
        logChange(
          getLogger(),
          `climate-adopt:${device.entityId}`,
          {
            entityId: device.entityId,
            adoptedMode: decision.desired.mode,
            adoptedTarget: decision.desired.target,
            adoptedTargetLow: decision.desired.targetLow,
            adoptedTargetHigh: decision.desired.targetHigh,
            adoptedFanMode: decision.desired.fanMode,
          },
          "climate enforcer adopted reported state",
        );
      }
      await store.writeReported({
        id: device.id,
        reported: mapped.reported,
        available: true,
        adoptDesired: decision.desired,
        now,
      });
      return;
    }
    case "push": {
      // Log the push before actuating , same reasoning as light-enforcer's push
      // line: a drift that never converges pushes every cycle, so logChange
      // (not a raw info) keeps a stuck thermostat loud but not a flood.
      logChange(
        getLogger(),
        `climate-push:${device.entityId}`,
        {
          entityId: device.entityId,
          mode: decision.desired.mode,
          target: decision.desired.target,
          targetLow: decision.desired.targetLow,
          targetHigh: decision.desired.targetHigh,
          fanMode: decision.desired.fanMode,
        },
        "climate enforcer pushing desired state to HA",
      );
      await pushToHa(device.entityId, decision.desired);
      await store.writeReported({
        id: device.id,
        reported: mapped.reported,
        available: true,
        now,
        ...(desiredFix !== undefined ? { adoptDesired: desiredFix } : {}),
      });
      return;
    }
    case "noop": {
      await store.writeReported({
        id: device.id,
        reported: mapped.reported,
        available: true,
        now,
        ...(desiredFix !== undefined ? { adoptDesired: desiredFix } : {}),
      });
      return;
    }
  }
}

/**
 * Actuate the desired climate state onto HA: hvac mode, then the setpoint shape
 * the desired carries (single `temperature` or the heat_cool range), then fan
 * mode when specified. Only the fields desired specifies are pushed.
 */
async function pushToHa(entityId: string, desired: DeviceClimateState): Promise<void> {
  await ha.callService("climate", "set_hvac_mode", {
    entity_id: entityId,
    hvac_mode: desired.mode,
  });
  // An off thermostat takes no setpoint , the remembered one is kept for the next
  // on, not actuated now (HA rejects set_temperature while off). Fan mode still is.
  if (climateSetpointsObservable(desired)) {
    if (desired.targetLow != null && desired.targetHigh != null) {
      await ha.callService("climate", "set_temperature", {
        entity_id: entityId,
        target_temp_low: desired.targetLow,
        target_temp_high: desired.targetHigh,
      });
    } else if (desired.target != null) {
      await ha.callService("climate", "set_temperature", {
        entity_id: entityId,
        temperature: desired.target,
      });
    }
  }
  if (desired.fanMode != null) {
    await ha.callService("climate", "set_fan_mode", {
      entity_id: entityId,
      fan_mode: desired.fanMode,
    });
  }
}
