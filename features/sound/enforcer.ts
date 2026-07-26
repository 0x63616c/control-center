/**
 * DB-authoritative Sonos volume enforcer (www-5mek).
 *
 * device_state.desiredState ({ volume }) is the source of truth for speaker
 * volume; the player is just an actuator , the same model as lights
 * (www-7d5b.2). The dashboard mutation writes desired + a short command window
 * and returns instantly; this 1s cycle reconciles each player:
 *   seed   → first sight copies reported → desired (adopt reality, no push)
 *   push   → drift while the command window is open: the app command owns the
 *            transition, write desired onto the player over UPnP
 *   adopt  → drift after the window: the Sonos app / hardware buttons are
 *            first-class controllers (like wall switches), absorb the change
 * Every speaker is adopt-policy , there is no enforce tier for volume, because
 * fighting a human turning a knob is never right for audio.
 *
 * Volume compares EXACTLY (integer 0-100, round-trips losslessly over UPnP) ,
 * no tolerance band needed, unlike HA color/brightness.
 */

import {
  DESK_RF_BONDED_UUID,
  DeviceKind,
  type DeviceSpeakerState,
  type DeviceStateStore,
  heartbeat,
  isSpeakerState,
  runCycle,
  SonosClient,
  TOPOLOGY_ANCHOR_IP,
  windowOpen,
} from "@www/core";
import { getLogger, logChange } from "@www/logger";
import { deviceStateStore, integrationSyncStore } from "./db";

const ENFORCER_INTEGRATION_ID = "sonos-volume-enforcer";
const SPEAKER_DOMAIN = "sonos";

// Backend-only hard volume cap (www-0wbm). Sonos exposes no device-level limit
// over UPnP and HA has no entity for it, so we enforce it here: the enforcer
// only ever actuates min(desired, cap), and external changes above the cap are
// pushed back down within a cycle. Deliberately HIDDEN from the frontend , the
// raw user-requested volume stays in desiredState and is what the panel renders,
// so the cap is invisible (the fader can still read 100, the speaker tops at 90).
export const SPEAKER_MAX_VOLUME = 90;

/** Clamp any volume to the backend cap. */
function capVolume(volume: number): number {
  return Math.min(volume, SPEAKER_MAX_VOLUME);
}

// A speaker row as the reconciler needs it (subset of the deviceState row).
interface ManagedSpeaker {
  id: string;
  deviceIp: string;
  desiredState: DeviceSpeakerState | null;
  desiredUntilUtc: Date | null;
}

/** One player's live reading; volume null when the device could not be read. */
interface SpeakerReading {
  volume: number | null;
  available: boolean;
}

export type SpeakerEnforcementDecision =
  | { kind: "noop" }
  | { kind: "unreachable" }
  | { kind: "seed"; desired: DeviceSpeakerState }
  | { kind: "adopt"; desired: DeviceSpeakerState }
  | { kind: "push"; desired: DeviceSpeakerState }
  // Cap: external volume exceeded SPEAKER_MAX_VOLUME , push the cap onto the
  // speaker but DON'T touch the raw desired (the cap is hidden, not adopted).
  | { kind: "cap"; desired: DeviceSpeakerState };

/** Pure reconcile decision for one speaker. No I/O , the cycle executes the result. */
export function decideSpeakerEnforcement(
  speaker: ManagedSpeaker,
  reading: SpeakerReading,
  now: Date = new Date(),
): SpeakerEnforcementDecision {
  // Unreachable: can't read truth, so can't push or adopt. Desired survives the
  // outage , intent is never wiped by unreachability.
  if (!reading.available || reading.volume == null) return { kind: "unreachable" };
  const reported: DeviceSpeakerState = { volume: reading.volume };

  // Seed keeps reality RAW (even above the cap); the cap branch below pushes it
  // down on the next cycle once a desired exists to compare against.
  if (speaker.desiredState == null) return { kind: "seed", desired: reported };

  // Convergence is judged against the CLAMPED desired: a desired of 100 with the
  // speaker sitting at the 90 cap is "converged" (noop), so an above-cap desired
  // never causes an endless push loop.
  const target = capVolume(speaker.desiredState.volume);
  if (reported.volume === target) return { kind: "noop" };

  if (windowOpen(speaker, now)) return { kind: "push", desired: { volume: target } };

  // Outside the window: an external change at/below the cap is adopted as the new
  // intent (Sonos app / hardware buttons win). Above the cap it is NOT honored ,
  // push the cap back down and leave the raw desired alone.
  if (reported.volume > SPEAKER_MAX_VOLUME) {
    return { kind: "cap", desired: { volume: SPEAKER_MAX_VOLUME } };
  }
  return { kind: "adopt", desired: reported };
}

/** Stable Stripe-style row id derived from the player's static LAN IP. */
function speakerDeviceId(deviceIp: string): string {
  return `spk_${deviceIp.replaceAll(".", "-")}`;
}

/**
 * The dashboard mutation path: accept the command instantly by upserting
 * desired + a command window, NEVER touching the speaker , the enforcer pushes
 * it within a cycle. THROWS on DB failure (the write is this mutation's only
 * effect, so a swallowed error would be fabricated success).
 */
export async function setSpeakerDesiredVolume({
  deviceIp,
  volume,
}: {
  deviceIp: string;
  volume: number;
}): Promise<void> {
  const desired: DeviceSpeakerState = { volume };
  // The store owns the upsert + command-window stamp and throws on DB failure
  // (the write is this mutation's only effect, so a swallow is fabricated success).
  await deviceStateStore.upsertDesired({
    id: speakerDeviceId(deviceIp),
    kind: DeviceKind.Speaker,
    entityId: deviceIp,
    domain: SPEAKER_DOMAIN,
    // Real label (zone name) is unknown here; the enforcer refreshes it from
    // topology on its next cycle.
    label: deviceIp,
    desired,
  });
}

export async function runSonosVolumeEnforcerCycle(
  store: DeviceStateStore = deviceStateStore,
): Promise<void> {
  await runCycle(
    heartbeat(integrationSyncStore, ENFORCER_INTEGRATION_ID),
    "sonos-volume-enforcer",
    () => reconcile(store),
  );
}

interface LivePlayer {
  ip: string;
  zoneName: string;
  reading: SpeakerReading;
}

/** Topology + per-player volume, read fresh every cycle (grouping is volatile). */
async function fetchPlayers(): Promise<LivePlayer[]> {
  const groups = await new SonosClient(TOPOLOGY_ANCHOR_IP).getZoneGroupState();
  const seen = new Set<string>();
  const members = groups
    .flatMap((g) => g.members)
    .filter((m) => m.uuid !== DESK_RF_BONDED_UUID)
    .filter((m) => (seen.has(m.ip) ? false : seen.add(m.ip)));

  return Promise.all(
    members.map(async (m): Promise<LivePlayer> => {
      try {
        const volume = await new SonosClient(m.ip).getVolume();
        return { ip: m.ip, zoneName: m.zoneName, reading: { volume, available: true } };
      } catch {
        // One dead player must not fail the whole cycle for its siblings, but
        // a failed probe is still a real signal (unreachable speaker) , warn
        // so it isn't silently swallowed.
        getLogger().warn(
          { ip: m.ip, zoneName: m.zoneName },
          "sonos volume probe failed, marking unavailable",
        );
        return { ip: m.ip, zoneName: m.zoneName, reading: { volume: null, available: false } };
      }
    }),
  );
}

async function reconcile(store: DeviceStateStore): Promise<void> {
  const players = await fetchPlayers();
  const rows = await store.list({ kind: DeviceKind.Speaker });
  const rowByIp = new Map(rows.map((r) => [r.entityId, r]));
  const now = new Date();

  for (const player of players) {
    const row = rowByIp.get(player.ip);
    rowByIp.delete(player.ip);

    if (!row) {
      // First sight with a readable volume: seed the row (desired = reported,
      // no push). Unreadable first sight: nothing to seed from.
      if (player.reading.volume == null) continue;
      const reported: DeviceSpeakerState = { volume: player.reading.volume };
      await store.seed({
        id: speakerDeviceId(player.ip),
        kind: DeviceKind.Speaker,
        entityId: player.ip,
        domain: SPEAKER_DOMAIN,
        label: player.zoneName,
        reported,
        desired: reported,
        available: true,
        now,
      });
      continue;
    }

    const speaker: ManagedSpeaker = {
      id: row.id,
      deviceIp: row.entityId,
      desiredState: isSpeakerState(row.desiredState) ? row.desiredState : null,
      desiredUntilUtc: row.desiredUntilUtc ?? null,
    };
    const decision = decideSpeakerEnforcement(speaker, player.reading, now);
    await applyDecision(speaker, decision, player, now, store);
  }

  // Rows for players that vanished from topology entirely: honest availability.
  // DeviceStateStore migration note: `writeReported` always stamps
  // reportedAtUtc to `now`, unlike the old raw update (available/updatedAtUtc
  // only) , this row's reportedAtUtc now advances even though no fresh volume
  // was read. Accepted: nothing reads device_state.reportedAtUtc downstream
  // (grep-verified), so this is not observable. reportedState itself is passed
  // through unchanged (row.reportedState) so the VALUE never drifts.
  for (const row of rowByIp.values()) {
    if (!row.available) continue;
    await store.writeReported({ id: row.id, reported: row.reportedState, available: false, now });
  }
}

async function applyDecision(
  speaker: ManagedSpeaker,
  decision: SpeakerEnforcementDecision,
  player: LivePlayer,
  now: Date,
  store: DeviceStateStore,
): Promise<void> {
  const reported: DeviceSpeakerState | null =
    player.reading.volume == null ? null : { volume: player.reading.volume };
  // DeviceStateStore migration note: the old raw update also refreshed `label`
  // to the player's live zoneName every cycle (rooms can be renamed in the
  // Sonos app). WriteReported has no label field, and no downstream consumer
  // reads device_state.label for speakers , sound-system.getSoundSystem()
  // renders room names from the LIVE topology (member.zoneName), never from
  // this DB row (grep-verified). So the label refresh is dropped here as a
  // safe, unobservable deviation rather than extending the store interface.

  switch (decision.kind) {
    case "unreachable": {
      await store.writeReported({ id: speaker.id, reported, available: false, now });
      return;
    }
    case "seed":
    case "adopt": {
      if (decision.kind === "adopt") {
        // 1s loop , only a change in the adopted volume is an event. See §3.
        logChange(
          getLogger(),
          `sonos-adopt:${speaker.deviceIp}`,
          { deviceIp: speaker.deviceIp, adoptedVolume: decision.desired.volume },
          "sonos-volume-enforcer adopted external volume",
        );
      }
      await store.writeReported({
        id: speaker.id,
        reported,
        available: true,
        adoptDesired: decision.desired,
        now,
      });
      return;
    }
    case "push":
    case "cap": {
      // A speaker that ignores setVolume is re-pushed every second; logChange
      // keeps that one event plus a `repeats` count instead of a flood. See §3.
      logChange(
        getLogger(),
        `sonos-push:${speaker.deviceIp}`,
        {
          deviceIp: speaker.deviceIp,
          volume: decision.desired.volume,
          capped: decision.kind === "cap",
        },
        decision.kind === "cap"
          ? "sonos-volume-enforcer capping external over-volume"
          : "sonos-volume-enforcer pushing desired volume",
      );
      // Both actuate the speaker and refresh reported/availability; neither writes
      // desiredState (push keeps the raw desired, cap deliberately hides itself).
      await new SonosClient(speaker.deviceIp).setVolume(decision.desired.volume);
      await store.writeReported({ id: speaker.id, reported, available: true, now });
      return;
    }
    case "noop": {
      await store.writeReported({ id: speaker.id, reported, available: true, now });
      return;
    }
  }
}
