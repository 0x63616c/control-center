import { Capacitor } from "@capacitor/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPanelMaintenance,
  isPanelMaintenanceAvailable,
  runPanelMaintenanceNow,
  setPanelMaintenance,
} from "../panel-maintenance";

const getConfiguration = vi.fn();
const setConfiguration = vi.fn();
const runNow = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(), isPluginAvailable: vi.fn() },
  registerPlugin: () => ({
    getConfiguration: () => getConfiguration(),
    setConfiguration: (options: unknown) => setConfiguration(options),
    runNow: () => runNow(),
  }),
}));

const isNative = vi.mocked(Capacitor.isNativePlatform);
const hasPlugin = vi.mocked(Capacitor.isPluginAvailable);

function onPanel(): void {
  isNative.mockReturnValue(true);
  hasPlugin.mockReturnValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  getConfiguration.mockResolvedValue({
    enabled: true,
    time: "03:00",
    nextRunAtMs: 1_788_260_400_000,
  });
  setConfiguration.mockImplementation((options) =>
    Promise.resolve({ ...options, nextRunAtMs: 1_788_264_000_000 }),
  );
  runNow.mockResolvedValue({ accepted: true });
});

describe("Panel maintenance bridge", () => {
  it("reports unavailable in an ordinary browser", async () => {
    isNative.mockReturnValue(false);
    hasPlugin.mockReturnValue(true);
    expect(isPanelMaintenanceAvailable()).toBe(false);
    await expect(getPanelMaintenance()).resolves.toBeNull();
    expect(getConfiguration).not.toHaveBeenCalled();
  });

  it("parses the native schedule", async () => {
    onPanel();
    await expect(getPanelMaintenance()).resolves.toEqual({
      enabled: true,
      time: "03:00",
      nextRunAtMs: 1_788_260_400_000,
    });
  });

  it("rejects malformed native data instead of trusting the bridge", async () => {
    onPanel();
    getConfiguration.mockResolvedValue({ enabled: true, time: "three", nextRunAtMs: -1 });
    await expect(getPanelMaintenance()).resolves.toBeNull();
  });

  it("writes a valid local time and returns the rescheduled run", async () => {
    onPanel();
    await expect(setPanelMaintenance({ enabled: true, time: "04:30" })).resolves.toEqual({
      enabled: true,
      time: "04:30",
      nextRunAtMs: 1_788_264_000_000,
    });
    expect(setConfiguration).toHaveBeenCalledWith({ enabled: true, time: "04:30" });
  });

  it("does not send an invalid time to native", async () => {
    onPanel();
    await expect(setPanelMaintenance({ enabled: true, time: "25:00" })).resolves.toBeNull();
    expect(setConfiguration).not.toHaveBeenCalled();
  });

  it("asks native to run the bounded reset immediately", async () => {
    onPanel();
    await expect(runPanelMaintenanceNow()).resolves.toBe(true);
    expect(runNow).toHaveBeenCalledOnce();
  });
});
