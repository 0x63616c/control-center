import {
  DeviceOwner,
  type DeviceStateStore,
  heartbeat,
  mapHaToReported,
  ownerOf,
  runCycle,
  stateEquals,
} from "@www/core";
import { getLogger, logChange } from "@www/logger";
import { deviceStateStore } from "../db/device-state-store";
import { integrationSyncStore } from "../db/integration-sync-store";
import { ha } from "../integrations/homeassistant";
import type { HaEntity } from "../integrations/homeassistant/types";

const SYNC_INTEGRATION_ID = "homeassistant";
// Fan-only since the M2 cutover (www-7d5b.2.6): the light enforcer
// (light-enforcer-service) is now the sole owner of light/switch reconcile, so
// device-sync no longer fetches or reconciles the 'light' domain , that would
// double-drive the lights. Fan stays read-from-HA via this loop.
const SYNC_DOMAINS = ["fan"] as const;

// One device-sync cycle. The schedule lives in the worker runtime (src/worker.ts,
// www-7d5b.1.2) , this module only exposes the single cycle plus the pure
// reconcile/sweep helpers it composes.
export async function runDeviceSyncCycle(
  store: DeviceStateStore = deviceStateStore,
): Promise<void> {
  await runCycle(heartbeat(integrationSyncStore, SYNC_INTEGRATION_ID), "device-sync", async () => {
    const snapshot = await fetchSnapshot();
    await reconcile(snapshot, store);
  });
}

async function fetchSnapshot(): Promise<Map<string, HaEntity>> {
  const lists = await Promise.all(SYNC_DOMAINS.map((d) => ha.getEntities(d)));
  const byEntityId = new Map<string, HaEntity>();
  for (const list of lists) for (const e of list) byEntityId.set(e.entity_id, e);
  return byEntityId;
}

export async function reconcile(
  snapshot: Map<string, HaEntity>,
  store: DeviceStateStore = deviceStateStore,
): Promise<void> {
  const devices = await store.list();
  const now = new Date();

  for (const device of devices) {
    // device-sync only reconciles the rows it OWNS. Rows owned by an enforcer
    // (lights, thermostat, speakers) are skipped , writing their state here would
    // fight the enforcer (double-drive). Ownership is data now; see ownerOf.
    if (ownerOf(device) !== DeviceOwner.DeviceSync) continue;

    const entity = snapshot.get(device.entityId);
    const { reported, available } = mapHaToReported(device.kind, entity);

    const reportedChanged = !stateEquals(device.reportedState ?? null, reported);
    const availabilityChanged = device.available !== available;

    if (reportedChanged || availabilityChanged) {
      // This loop runs every second, so log only a changed observation through
      // logChange. It makes a persisted HA update diagnosable without turning
      // steady state into a stream of identical lines.
      logChange(
        getLogger(),
        `device-sync-reported:${device.entityId}`,
        {
          deviceId: device.id,
          entityId: device.entityId,
          reported,
          available,
        },
        "device-sync observed reported state change",
      );
      // Parity note: the legacy raw update here never touched updatedAtUtc;
      // writeReported always stamps it. Ruled acceptable (controller,
      // Task 9) , it makes updatedAtUtc honest ("row last written") and no
      // reader depends on it (A8 review grep-verified zero readers).
      await store.writeReported({
        id: device.id,
        reported,
        available,
        changed: reportedChanged,
        now,
      });
    }

    if (
      device.desiredUntilUtc &&
      device.desiredState &&
      stateEquals(reported, device.desiredState) &&
      device.desiredUntilUtc > now
    ) {
      // Clearing this window means HA converged to the panel command before it
      // timed out. Keep it distinct from the timeout warning below so a missed
      // command and a successful one remain diagnosable events.
      logChange(
        getLogger(),
        `device-sync-converged:${device.entityId}`,
        {
          deviceId: device.id,
          entityId: device.entityId,
          desired: device.desiredState,
          reported,
        },
        "device-sync observed desired state and cleared command window",
      );
      await store.clearDesired(device.id);
    }
  }

  await sweepExpiredWindows(now, store);
}

export async function sweepExpiredWindows(
  now: Date,
  store: DeviceStateStore = deviceStateStore,
): Promise<void> {
  const expired = await store.listExpiredWindows(now);

  for (const device of expired) {
    // Never sweep a row device-sync doesn't own: desired is sticky truth for the
    // enforcer-owned rows (lights, thermostat, speakers), so clearing it here
    // would wipe the enforcer's intent. Same ownership check as reconcile().
    if (ownerOf(device) !== DeviceOwner.DeviceSync) continue;

    // The command window closed without HA ever converging to the desired
    // state , warn (not info) since a timed-out command is a real signal that
    // something didn't take, per docs/logging.md §5's named gap.
    logChange(
      getLogger(),
      `device-sync-timeout:${device.id}`,
      {
        deviceId: device.id,
        entityId: device.entityId,
        desired: device.desiredState,
        elapsed: device.desiredUntilUtc ? now.getTime() - device.desiredUntilUtc.getTime() : null,
      },
      "command window expired, clearing desired",
      { level: "warn" },
    );

    await store.clearDesired(device.id);
  }
}
