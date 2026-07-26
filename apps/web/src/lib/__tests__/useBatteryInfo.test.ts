import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const isNativePlatform = vi.fn(() => true);
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform() },
}));

let getBatteryInfo = vi.fn();
vi.mock("@capacitor/device", () => ({
  Device: { getBatteryInfo: () => getBatteryInfo() },
}));

const { formatBattery, useBatteryInfo } = await import("../useBatteryInfo");

describe("formatBattery", () => {
  it("renders the rounded percent only", () => {
    expect(formatBattery({ level: 0.87, isCharging: false })).toBe("87%");
  });

  it("ignores charging state , the string is percent-only (colour conveys charging)", () => {
    expect(formatBattery({ level: 0.87, isCharging: true })).toBe("87%");
  });
});

describe("useBatteryInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    isNativePlatform.mockReturnValue(true);
  });

  it("resets to unknown (not a stale reading) when a read comes back unreadable (#201)", async () => {
    getBatteryInfo = vi
      .fn()
      .mockResolvedValueOnce({ batteryLevel: 0.5, isCharging: false })
      .mockResolvedValueOnce({ batteryLevel: null, isCharging: null });

    const { result } = renderHook(() => useBatteryInfo(true));

    await waitFor(() => expect(result.current).toEqual({ level: 0.5, isCharging: false }));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(result.current).toBeNull());
  });

  it("re-reads immediately when the panel becomes visible again, not just on the poll timer", async () => {
    getBatteryInfo = vi
      .fn()
      .mockResolvedValueOnce({ batteryLevel: 0.2, isCharging: false })
      .mockResolvedValueOnce({ batteryLevel: 0.2, isCharging: true });

    const { result } = renderHook(() => useBatteryInfo(true));

    await waitFor(() => expect(result.current).toEqual({ level: 0.2, isCharging: false }));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(result.current).toEqual({ level: 0.2, isCharging: true }));
    expect(getBatteryInfo).toHaveBeenCalledTimes(2);
  });
});
