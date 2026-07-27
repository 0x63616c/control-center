/**
 * Tests for the DB-authoritative Sonos volume enforcer (www-5mek).
 *
 * Mirrors the light-enforcer pattern: the reconcile decision is a PURE function
 * (decideSpeakerEnforcement) tested directly, then cycle-level tests inject an
 * in-memory DeviceStateStore (+ mocked SonosClient) to prove decisions are
 * executed (UPnP writes / store writes) only on the right branches, and the
 * mutation path writes desired WITHOUT touching the speaker.
 *
 * `setSpeakerDesiredVolume` calls the module-level `deviceStateStore.upsertDesired`
 * (the feature's own pg adapter, wrapping `./db`) rather than taking a store
 * param, so that one test mocks `./db`'s exported store directly; everything
 * else uses the injectable in-memory store.
 */
import { createInMemoryDeviceStateStore, DeviceKind } from "@www/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── mock the feature's own deviceStateStore (only backs setSpeakerDesiredVolume's
// module-level upsertDesired call) ─────────────────────────────────────────────

const { mockUpsertDesired } = vi.hoisted(() => ({ mockUpsertDesired: vi.fn() }));

vi.mock("./db", async () => {
  const { createInMemoryIntegrationSyncStore: makeStore } =
    await vi.importActual<typeof import("@www/core")>("@www/core");
  return {
    deviceStateStore: { upsertDesired: mockUpsertDesired },
    // The real in-memory store , runSonosVolumeEnforcerCycle's heartbeat()
    // wrapper needs a working recordFail/recordSuccess, which none of these
    // tests assert on.
    integrationSyncStore: makeStore(),
  };
});

// ─── mock SonosClient (per-IP, like sonos-sound-system tests) ─────────────────

type MockClient = {
  getZoneGroupState: ReturnType<typeof vi.fn>;
  getVolume: ReturnType<typeof vi.fn>;
  setVolume: ReturnType<typeof vi.fn>;
};

const mockClients: Record<string, MockClient> = {};
const constructedIps: string[] = [];

function makeMockClient(): MockClient {
  return {
    getZoneGroupState: vi.fn(),
    getVolume: vi.fn(),
    setVolume: vi.fn(),
  };
}

vi.mock("@www/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@www/core")>();
  return {
    ...actual,
    SonosClient: vi.fn().mockImplementation((ip: string) => {
      constructedIps.push(ip);
      if (!mockClients[ip]) mockClients[ip] = makeMockClient();
      return mockClients[ip];
    }),
  };
});

// ─── import after mocks ───────────────────────────────────────────────────────

import type { DeviceSpeakerState } from "@www/core";
import { TOPOLOGY_ANCHOR_IP } from "@www/core";
import { integrationSyncStore } from "./db";
import {
  decideSpeakerEnforcement,
  runSonosVolumeEnforcerCycle,
  SPEAKER_MAX_VOLUME,
  setSpeakerDesiredVolume,
} from "./enforcer";

// Mirrors ENFORCER_INTEGRATION_ID in ./enforcer, which is not exported.
const ENFORCER_INTEGRATION_ID = "sonos-volume-enforcer";

// ─── helpers ──────────────────────────────────────────────────────────────────

const LIVING_IP = "192.168.0.193";
const DESK_IP = "192.168.0.194";

function speaker(
  overrides: Partial<{
    id: string;
    deviceIp: string;
    desiredState: DeviceSpeakerState | null;
    desiredUntilUtc: Date | null;
  }> = {},
) {
  return {
    id: "spk_192-168-0-193",
    deviceIp: LIVING_IP,
    desiredState: null,
    desiredUntilUtc: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mockClients)) delete mockClients[key];
  constructedIps.length = 0;
});

// ─── pure decision matrix ─────────────────────────────────────────────────────

describe("decideSpeakerEnforcement", () => {
  const now = new Date("2026-01-01T00:00:05Z");
  const openWindow = new Date("2026-01-01T00:00:10Z");
  const expiredWindow = new Date("2026-01-01T00:00:01Z");

  it("unreachable when the speaker could not be read", () => {
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: { volume: 30 } }),
      { volume: null, available: false },
      now,
    );
    expect(d.kind).toBe("unreachable");
  });

  it("seeds desired from reported when desired is null (no push)", () => {
    const d = decideSpeakerEnforcement(speaker(), { volume: 25, available: true }, now);
    expect(d).toEqual({ kind: "seed", desired: { volume: 25 } });
  });

  it("noop when desired matches reported exactly", () => {
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: { volume: 25 } }),
      { volume: 25, available: true },
      now,
    );
    expect(d.kind).toBe("noop");
  });

  it("pushes desired on drift INSIDE the command window (app command owns it)", () => {
    const desired: DeviceSpeakerState = { volume: 60 };
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: desired, desiredUntilUtc: openWindow }),
      { volume: 25, available: true },
      now,
    );
    expect(d.kind).toBe("push");
    // Pushes a clamped COPY of desired (60 is below the cap, so value-equal).
    if (d.kind === "push") expect(d.desired).toEqual(desired);
  });

  it("adopts external drift OUTSIDE the window (Sonos app changes win)", () => {
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: { volume: 60 }, desiredUntilUtc: expiredWindow }),
      { volume: 25, available: true },
      now,
    );
    expect(d).toEqual({ kind: "adopt", desired: { volume: 25 } });
  });

  it("adopts external drift when no window was ever set", () => {
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: { volume: 60 }, desiredUntilUtc: null }),
      { volume: 25, available: true },
      now,
    );
    expect(d).toEqual({ kind: "adopt", desired: { volume: 25 } });
  });
});

// ─── max-volume cap (www-0wbm): backend-only, hidden from the frontend ─────────

describe("decideSpeakerEnforcement max-volume cap", () => {
  const now = new Date("2026-01-01T00:00:05Z");
  const openWindow = new Date("2026-01-01T00:00:10Z");
  const expiredWindow = new Date("2026-01-01T00:00:01Z");

  it("exports the cap as 90", () => {
    expect(SPEAKER_MAX_VOLUME).toBe(90);
  });

  it("desired ABOVE the cap with reported AT the cap is converged (hidden-cap noop)", () => {
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: { volume: 100 } }),
      { volume: 90, available: true },
      now,
    );
    expect(d.kind).toBe("noop");
  });

  it("pushes the CLAMPED volume on drift inside the window (desired 100 -> push 90)", () => {
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: { volume: 100 }, desiredUntilUtc: openWindow }),
      { volume: 50, available: true },
      now,
    );
    expect(d).toEqual({ kind: "push", desired: { volume: 90 } });
  });

  it("external drift ABOVE the cap is capped back down, never adopted (cap overrides adopt)", () => {
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: { volume: 50 }, desiredUntilUtc: expiredWindow }),
      { volume: 95, available: true },
      now,
    );
    expect(d).toEqual({ kind: "cap", desired: { volume: 90 } });
  });

  it("external drift AT or BELOW the cap still adopts as before", () => {
    const d = decideSpeakerEnforcement(
      speaker({ desiredState: { volume: 50 }, desiredUntilUtc: expiredWindow }),
      { volume: 80, available: true },
      now,
    );
    expect(d).toEqual({ kind: "adopt", desired: { volume: 80 } });
  });

  it("seeding from an above-cap reality keeps the raw value (cap pushes it down next cycle)", () => {
    const d = decideSpeakerEnforcement(speaker(), { volume: 95, available: true }, now);
    expect(d).toEqual({ kind: "seed", desired: { volume: 95 } });
  });
});

// ─── mutation path: accept straight away, never touch the speaker ─────────────

describe("setSpeakerDesiredVolume", () => {
  it("upserts desiredState via the store and makes NO SonosClient call", async () => {
    mockUpsertDesired.mockResolvedValue(undefined);

    await setSpeakerDesiredVolume({ deviceIp: LIVING_IP, volume: 42 });

    expect(constructedIps).toEqual([]);
    expect(mockUpsertDesired).toHaveBeenCalledTimes(1);
    const input = mockUpsertDesired.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      kind: "speaker",
      entityId: LIVING_IP,
      desired: { volume: 42 },
    });
    // Command-window stamping is the pg adapter's responsibility (createPgDeviceStateStore,
    // tested in @www/core); this test only proves the mutation's call shape.
  });
});

// ─── cycle integration (in-memory DeviceStateStore + mocked SonosClient) ──────

// Get-or-create: LIVING_IP IS the topology anchor, so tests must never replace
// an existing mock client (that would clobber getZoneGroupState).
function client(ip: string): MockClient {
  if (!mockClients[ip]) mockClients[ip] = makeMockClient();
  return mockClients[ip];
}

function topology(members: { ip: string; uuid: string; zoneName: string }[]) {
  client(TOPOLOGY_ANCHOR_IP).getZoneGroupState.mockResolvedValue([
    {
      coordinatorUuid: members[0].uuid,
      members,
    },
  ]);
}

async function seededStore(row: {
  entityId?: string;
  label?: string;
  desiredState: DeviceSpeakerState | null;
  reportedState: DeviceSpeakerState | null;
  available: boolean;
  desiredUntilUtc?: Date | null;
}) {
  const store = createInMemoryDeviceStateStore();
  await store.seed({
    id: "spk_192-168-0-193",
    kind: DeviceKind.Speaker,
    entityId: row.entityId ?? LIVING_IP,
    domain: "sonos",
    label: row.label ?? "Living Room",
    reported: row.reportedState,
    desired: row.desiredState,
    available: row.available,
  });
  if (row.desiredUntilUtc != null && row.desiredState != null) {
    // seed() never sets a command window (desiredUntilUtc stays null, i.e. no
    // open window , exactly what the "outside the window" tests want). Open
    // one explicitly only when a window is actually requested, via
    // updateDesired's windowMs, matching the climate-enforcer test pattern.
    const windowMs = row.desiredUntilUtc.getTime() - Date.now();
    await store.updateDesired({ id: "spk_192-168-0-193", desired: row.desiredState, windowMs });
  }
  return store;
}

describe("runSonosVolumeEnforcerCycle", () => {
  it("pushes desired volume to the speaker on drift inside the window", async () => {
    topology([{ ip: LIVING_IP, uuid: "RINCON_LIVING", zoneName: "Living Room" }]);
    client(LIVING_IP).getVolume.mockResolvedValue(20);
    const store = await seededStore({
      desiredState: { volume: 55 },
      reportedState: { volume: 55 },
      available: true,
      desiredUntilUtc: new Date(Date.now() + 9_000),
    });

    await runSonosVolumeEnforcerCycle(store);

    expect(client(LIVING_IP).setVolume).toHaveBeenCalledWith(55);
  });

  it("adopts external drift outside the window: writes desired=reported, no UPnP write", async () => {
    topology([{ ip: LIVING_IP, uuid: "RINCON_LIVING", zoneName: "Living Room" }]);
    client(LIVING_IP).getVolume.mockResolvedValue(20);
    const store = await seededStore({
      desiredState: { volume: 55 },
      reportedState: { volume: 55 },
      available: true,
      desiredUntilUtc: null,
    });

    await runSonosVolumeEnforcerCycle(store);

    expect(client(LIVING_IP).setVolume).not.toHaveBeenCalled();
    const row = await store.read("spk_192-168-0-193");
    expect(row?.desiredState).toEqual({ volume: 20 });
  });

  it("caps external over-volume back to 90 over UPnP, leaving raw desired untouched", async () => {
    // Someone bumped the speaker to 100 from the Sonos app, window expired.
    topology([{ ip: LIVING_IP, uuid: "RINCON_LIVING", zoneName: "Living Room" }]);
    client(LIVING_IP).getVolume.mockResolvedValue(100);
    const store = await seededStore({
      desiredState: { volume: 50 },
      reportedState: { volume: 50 },
      available: true,
      desiredUntilUtc: null,
    });

    await runSonosVolumeEnforcerCycle(store);

    // Pushed the cap down to the speaker...
    expect(client(LIVING_IP).setVolume).toHaveBeenCalledWith(90);
    // ...without overwriting the user's raw desired (cap is hidden from the row).
    const row = await store.read("spk_192-168-0-193");
    expect(row?.desiredState).toEqual({ volume: 50 });
  });

  it("seeds a row for a first-seen player (desired = reported, no push)", async () => {
    topology([{ ip: DESK_IP, uuid: "RINCON_DESK", zoneName: "Desk" }]);
    client(DESK_IP).getVolume.mockResolvedValue(33);
    const store = createInMemoryDeviceStateStore();

    await runSonosVolumeEnforcerCycle(store);

    expect(client(DESK_IP).setVolume).not.toHaveBeenCalled();
    const rows = await store.list({ kind: DeviceKind.Speaker });
    const seeded = rows.find((r) => r.entityId === DESK_IP);
    expect(seeded).toBeDefined();
    expect(seeded).toMatchObject({
      label: "Desk",
      desiredState: { volume: 33 },
      reportedState: { volume: 33 },
      available: true,
    });
  });

  it("marks a speaker unavailable when its volume read fails, leaving desired intact", async () => {
    topology([{ ip: LIVING_IP, uuid: "RINCON_LIVING", zoneName: "Living Room" }]);
    client(LIVING_IP).getVolume.mockRejectedValue(new Error("timeout"));
    const store = await seededStore({
      desiredState: { volume: 55 },
      reportedState: { volume: 55 },
      available: true,
    });

    await runSonosVolumeEnforcerCycle(store);

    expect(client(LIVING_IP).setVolume).not.toHaveBeenCalled();
    const row = await store.read("spk_192-168-0-193");
    expect(row?.available).toBe(false);
    // Desired must survive the outage , intent is never wiped by unreachability.
    expect(row?.desiredState).toEqual({ volume: 55 });
  });

  it("marks a vanished-from-topology speaker unavailable without touching reportedState", async () => {
    // Topology has no players at all this cycle; the previously-seen Living
    // Room row must be flipped unavailable, and its stored reportedState value
    // preserved (only reportedAtUtc/updatedAtUtc/available change).
    client(TOPOLOGY_ANCHOR_IP).getZoneGroupState.mockResolvedValue([]);
    const store = await seededStore({
      entityId: LIVING_IP,
      desiredState: { volume: 55 },
      reportedState: { volume: 20 },
      available: true,
    });

    await runSonosVolumeEnforcerCycle(store);

    const row = await store.read("spk_192-168-0-193");
    expect(row?.available).toBe(false);
    expect(row?.reportedState).toEqual({ volume: 20 });
    expect(row?.desiredState).toEqual({ volume: 55 });
  });

  // www-355t.9 / #149: runCycle (packages/core/src/integration-sync/heartbeat.ts)
  // must rethrow a failing cycle instead of swallowing it, so the worker
  // runtime's onset/ongoing/recovery transition logging actually fires for
  // this loop. A topology-fetch failure (unlike a single dead player, which
  // fetchPlayers already isolates) is not caught anywhere in reconcile(), so
  // it propagates out of the cycle , assert both that the rejection surfaces
  // AND that the heartbeat failure streak landed before the throw, mirroring
  // packages/core/test/heartbeat.test.ts's "records the heartbeat failure
  // BEFORE rethrowing" case.
  it("propagates a topology-fetch failure and records the heartbeat streak before rethrowing", async () => {
    client(TOPOLOGY_ANCHOR_IP).getZoneGroupState.mockRejectedValue(
      new Error("topology unreachable"),
    );
    const store = createInMemoryDeviceStateStore();

    await expect(runSonosVolumeEnforcerCycle(store)).rejects.toThrow("topology unreachable");

    const row = await integrationSyncStore.read(ENFORCER_INTEGRATION_ID);
    expect(row?.lastError).toBe("topology unreachable");
    expect(row?.consecutiveFailures).toBe(1);
  });
});
