import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTail } from "../log/logger";
import { resetNativeDiagnosticsForTests, startNativeDiagnostics } from "../native-diagnostics";

const getSnapshot = vi.fn(() =>
  Promise.resolve({
    currentRun: {
      runId: "current",
      startedAtMs: 1,
      lastUpdatedAtMs: 2,
      lifecycleState: "active",
      memoryWarnings: 0,
      footprintBytes: 100,
      peakFootprintBytes: 120,
    },
    previousRun: {
      runId: "previous",
      startedAtMs: 3,
      lastUpdatedAtMs: 4,
      lifecycleState: "active",
      memoryWarnings: 1,
      footprintBytes: 900,
      peakFootprintBytes: 950,
    },
    physicalMemoryBytes: 6_000,
    osVersion: "test",
  }),
);

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(), isPluginAvailable: vi.fn() },
  registerPlugin: () => ({ getSnapshot: () => getSnapshot() }),
}));

const isNative = vi.mocked(Capacitor.isNativePlatform);
const hasPlugin = vi.mocked(Capacitor.isPluginAvailable);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetNativeDiagnosticsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startNativeDiagnostics", () => {
  it("is inert in a browser", () => {
    isNative.mockReturnValue(false);
    const stop = startNativeDiagnostics();
    expect(getSnapshot).not.toHaveBeenCalled();
    stop();
  });

  it("records the previous native process once, then low-rate current snapshots", async () => {
    isNative.mockReturnValue(true);
    hasPlugin.mockReturnValue(true);
    const before = getTail().length;

    const stop = startNativeDiagnostics();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

    const entries = getTail()
      .slice(before)
      .filter((entry) => entry.source === "native-diagnostics" && entry.msg === "process snapshot");
    expect(entries).toHaveLength(2);
    expect(entries[0]?.data).toMatchObject({
      reason: "boot",
      previousRun: { runId: "previous", memoryWarnings: 1, peakFootprintBytes: 950 },
    });
    expect(entries[1]?.data).toMatchObject({ reason: "heartbeat" });
    expect(entries[1]?.data).not.toHaveProperty("previousRun");
    stop();
  });
});
