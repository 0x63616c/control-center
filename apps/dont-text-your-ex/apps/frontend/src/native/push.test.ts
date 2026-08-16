import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enablePush, setPushPluginForTests } from "./push";

describe("native push registration", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("prompts only from an explicit enable call and registers the callback token", async () => {
    let registration: ((token: { value: string }) => void) | undefined;
    const plugin = {
      checkPermissions: vi.fn(async () => ({ receive: "prompt" as const })),
      requestPermissions: vi.fn(async () => ({ receive: "granted" as const })),
      register: vi.fn(async () => registration?.({ value: "ab".repeat(32) })),
      addListener: vi.fn(async (event: string, callback: (value: never) => void) => {
        if (event === "registration") registration = callback as typeof registration;
        return { remove: vi.fn() };
      }),
    };
    setPushPluginForTests(plugin);
    const registerDevice = vi.fn(async () => ({ status: "registered" as const }));

    await expect(
      enablePush(registerDevice, async () => ({ version: "1.0", build: "24" })),
    ).resolves.toEqual({ ok: true });
    expect(plugin.requestPermissions).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(registerDevice).toHaveBeenCalledWith(
        expect.objectContaining({
          installationId: expect.stringMatching(/^dev_/),
          token: "ab".repeat(32),
          platform: "ios",
          appVersion: "1.0",
          appBuild: "24",
        }),
      ),
    );
  });

  it("does not prompt while refreshing an already-granted registration", async () => {
    const plugin = {
      checkPermissions: vi.fn(async () => ({ receive: "granted" as const })),
      requestPermissions: vi.fn(),
      register: vi.fn(),
      addListener: vi.fn(async () => ({ remove: vi.fn() })),
    };
    setPushPluginForTests(plugin);

    await enablePush(vi.fn(), async () => ({ version: "1.0", build: "24" }));

    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.register).toHaveBeenCalledOnce();
  });
});
