import { Capacitor } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTail } from "../log/logger";
import { resetNativeDiagnosticsForTests, startNativeDiagnostics } from "../native-diagnostics";

const getSnapshot = vi.fn<() => Promise<unknown>>(() =>
  Promise.resolve({
    currentRun: {
      runId: "current",
      startedAtMs: 1,
      lastUpdatedAtMs: 2,
      lifecycleState: "active",
      memoryWarnings: 0,
      warningEvents: [
        {
          timestampMs: 2,
          lifecycleState: "active",
          footprintBytes: 100,
          peakFootprintBytes: 120,
        },
      ],
      webContentTerminations: [],
      recoveryEvents: [
        {
          timestampMs: 3,
          trigger: "memory-warning",
          outcome: "staged-web-document-reset",
        },
        {
          timestampMs: 4,
          trigger: "scheduled-maintenance",
          outcome: "staged-web-document-reset",
        },
      ],
      footprintBytes: 100,
      peakFootprintBytes: 120,
      cpuTimeSeconds: 42,
      cpuPercentOfOneCore: 7.5,
      thermalState: "nominal",
      batteryLevel: 83,
      batteryState: "charging",
      appUptimeSeconds: 3_600,
      systemUptimeSeconds: 86_400,
    },
    previousRun: {
      runId: "previous",
      startedAtMs: 3,
      lastUpdatedAtMs: 4,
      lifecycleState: "active",
      memoryWarnings: 1,
      warningEvents: [],
      webContentTerminations: [],
      recoveryEvents: [],
      footprintBytes: 900,
      peakFootprintBytes: 950,
      cpuTimeSeconds: 100,
      cpuPercentOfOneCore: 3,
      thermalState: "fair",
      batteryLevel: 80,
      batteryState: "unplugged",
      appUptimeSeconds: 31_000,
      systemUptimeSeconds: 120_000,
    },
    physicalMemoryBytes: 6_000,
    osVersion: "test",
    metricKitRecords: [
      {
        sequence: 1,
        kind: "metric",
        receivedAtMs: 5,
        rawPayloadBytes: 70_000,
        truncated: true,
        evidence: [
          { path: "applicationMemoryMetrics.peakMemoryUsage", value: "123" },
          {
            path: "applicationExitMetrics.cumulativeMemoryResourceLimitExitCount",
            value: "2",
          },
        ],
      },
    ],
  }),
);

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(), isPluginAvailable: vi.fn() },
  registerPlugin: () => ({ getSnapshot: () => getSnapshot() }),
}));

const isNative = vi.mocked(Capacitor.isNativePlatform);
const hasPlugin = vi.mocked(Capacitor.isPluginAvailable);

function build104RunWithoutBatteryLevel(runId: string) {
  return {
    runId,
    startedAtMs: 1,
    lastUpdatedAtMs: 2,
    lifecycleState: "active",
    memoryWarnings: 0,
    warningEvents: [],
    webContentTerminations: [],
    recoveryEvents: [],
    footprintBytes: 100,
    peakFootprintBytes: 120,
    cpuTimeSeconds: 42,
    cpuPercentOfOneCore: 7.5,
    thermalState: "nominal",
    batteryState: "unknown",
    appUptimeSeconds: 3_600,
    systemUptimeSeconds: 86_400,
  };
}

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
      currentRun: {
        cpuTimeSeconds: 42,
        cpuPercentOfOneCore: 7.5,
        thermalState: "nominal",
        batteryLevel: 83,
        appUptimeSeconds: 3_600,
        systemUptimeSeconds: 86_400,
        warningEventHistoryCount: 1,
      },
      previousRun: { runId: "previous", memoryWarnings: 1, peakFootprintBytes: 950 },
    });
    expect(entries[0]?.data).not.toHaveProperty("metricKitRecords");
    expect(entries[1]?.data).toMatchObject({ reason: "heartbeat" });
    expect(entries[1]?.data).not.toHaveProperty("previousRun");

    const metricEntries = getTail()
      .slice(before)
      .filter(
        (entry) => entry.source === "native-diagnostics" && entry.msg === "MetricKit evidence",
      );
    expect(metricEntries).toHaveLength(1);
    expect(metricEntries[0]?.data).toMatchObject({
      sequence: 1,
      kind: "metric",
      evidence: expect.arrayContaining([
        { path: "applicationMemoryMetrics.peakMemoryUsage", value: "123" },
        { path: "applicationExitMetrics.cumulativeMemoryResourceLimitExitCount", value: "2" },
      ]),
    });
    expect(JSON.stringify(metricEntries[0]?.data)).not.toContain("networkRequests");
    expect(JSON.stringify(metricEntries[0]?.data).length).toBeLessThan(2_000);

    const warningEntries = getTail()
      .slice(before)
      .filter(
        (entry) => entry.source === "native-diagnostics" && entry.msg === "memory warning evidence",
      );
    expect(warningEntries).toHaveLength(1);
    expect(warningEntries[0]?.data).toMatchObject({
      runId: "current",
      runOrigin: "current",
      timestampMs: 2,
      footprintBytes: 100,
    });
    const recoveryEntries = getTail()
      .slice(before)
      .filter((entry) => entry.source === "native-diagnostics" && entry.msg === "panel recovery");
    expect(recoveryEntries).toHaveLength(2);
    expect(recoveryEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          data: expect.objectContaining({
            runId: "current",
            runOrigin: "current",
            trigger: "memory-warning",
            outcome: "staged-web-document-reset",
          }),
        }),
        expect.objectContaining({
          level: "info",
          data: expect.objectContaining({
            runId: "current",
            runOrigin: "current",
            trigger: "scheduled-maintenance",
            outcome: "staged-web-document-reset",
          }),
        }),
      ]),
    );
    stop();
  });

  it("records the bounded Build 103 native snapshot during a staggered rollout", async () => {
    isNative.mockReturnValue(true);
    hasPlugin.mockReturnValue(true);
    getSnapshot.mockResolvedValueOnce({
      currentRun: {
        runId: "6ee006bb-fe0f-442c-ae85-2449115efd9d",
        startedAtMs: 1_787_670_216_822,
        lastUpdatedAtMs: 1_787_768_316_194,
        lifecycleState: "active",
        memoryWarnings: 0,
        footprintBytes: 13_812_976,
        peakFootprintBytes: 14_157_040,
      },
      physicalMemoryBytes: 5_942_460_416,
      osVersion: "18.7.8",
    });
    const before = getTail().length;

    const stop = startNativeDiagnostics();
    await vi.advanceTimersByTimeAsync(0);

    const entries = getTail()
      .slice(before)
      .filter((entry) => entry.source === "native-diagnostics");
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "process snapshot",
        data: expect.objectContaining({
          reason: "boot",
          currentRun: expect.objectContaining({
            runId: "6ee006bb-fe0f-442c-ae85-2449115efd9d",
            footprintBytes: 13_812_976,
            peakFootprintBytes: 14_157_040,
            diagnosticsSchema: "build-103",
            cpuTimeSeconds: null,
            warningEventHistoryCount: 0,
          }),
        }),
      }),
    ]);
    stop();
  });

  it("records Build 104 diagnostics when iOS omits an unavailable battery level", async () => {
    isNative.mockReturnValue(true);
    hasPlugin.mockReturnValue(true);
    getSnapshot.mockResolvedValueOnce({
      currentRun: build104RunWithoutBatteryLevel("build-104-current"),
      previousRun: build104RunWithoutBatteryLevel("build-104-previous"),
      physicalMemoryBytes: 6_000,
      osVersion: "18.7.8",
    });
    const before = getTail().length;

    const stop = startNativeDiagnostics();
    await vi.advanceTimersByTimeAsync(0);

    const entries = getTail()
      .slice(before)
      .filter((entry) => entry.source === "native-diagnostics");
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "process snapshot",
        data: expect.objectContaining({
          currentRun: expect.objectContaining({
            diagnosticsSchema: "build-104",
            batteryLevel: null,
          }),
          previousRun: expect.objectContaining({
            diagnosticsSchema: "build-104",
            batteryLevel: null,
          }),
        }),
      }),
    ]);
    stop();
  });

  it("rejects a version-skewed native payload at the plugin boundary", async () => {
    isNative.mockReturnValue(true);
    hasPlugin.mockReturnValue(true);
    getSnapshot.mockResolvedValueOnce({ currentRun: { runId: "incomplete" } });
    const before = getTail().length;

    const stop = startNativeDiagnostics();
    await vi.advanceTimersByTimeAsync(0);

    const entries = getTail()
      .slice(before)
      .filter((entry) => entry.source === "native-diagnostics");
    expect(entries).toEqual([
      expect.objectContaining({
        level: "warn",
        msg: "snapshot rejected",
        data: expect.objectContaining({ reason: "boot" }),
      }),
    ]);
    stop();
  });
});
