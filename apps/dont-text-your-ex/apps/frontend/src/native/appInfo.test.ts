import { beforeEach, describe, expect, it, vi } from "vitest";
import { getNativeAppInfo } from "./appInfo";

const native = vi.hoisted(() => ({
  getInfo: vi.fn(),
  isNativePlatform: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: native.isNativePlatform },
  registerPlugin: () => ({ getInfo: native.getInfo }),
}));

describe("native app-info boundary", () => {
  beforeEach(() => {
    native.getInfo.mockReset();
    native.isNativePlatform.mockReset();
    native.isNativePlatform.mockReturnValue(true);
  });

  it("parses the untrusted Capacitor plugin response before exposing it", async () => {
    native.getInfo.mockResolvedValue({ version: "1.2.3", build: "42" });
    await expect(getNativeAppInfo()).resolves.toEqual({ version: "1.2.3", build: "42" });

    native.getInfo.mockResolvedValue({ version: "1.2.3", build: 42 });
    await expect(getNativeAppInfo()).rejects.toThrow();

    native.getInfo.mockResolvedValue({ version: "1.2.3", build: "42", extra: true });
    await expect(getNativeAppInfo()).rejects.toThrow();
  });

  it("does not call the native plugin from the browser", async () => {
    native.isNativePlatform.mockReturnValue(false);

    await expect(getNativeAppInfo()).resolves.toBeNull();
    expect(native.getInfo).not.toHaveBeenCalled();
  });
});
