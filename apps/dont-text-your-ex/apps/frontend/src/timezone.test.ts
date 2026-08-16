import { describe, expect, it, vi } from "vitest";
import { currentDeviceTimeZone, refreshStoredTimeZone } from "./timezone";

describe("device timezone refresh", () => {
  it("parses IANA names at the device boundary", () => {
    expect(currentDeviceTimeZone(() => "America/New_York")).toBe("America/New_York");
    expect(currentDeviceTimeZone(() => "PST")).toBeNull();
    expect(currentDeviceTimeZone(() => "Not/AZone")).toBeNull();
  });

  it("sends only a validated timezone", async () => {
    const update = vi.fn(async () => ({ ok: true }));
    await expect(refreshStoredTimeZone(update, () => "Europe/London")).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith({ timezone: "Europe/London" });

    update.mockClear();
    await expect(refreshStoredTimeZone(update, () => undefined)).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
