import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasMigratedForTests,
  isDeviceNameSet,
  resetDeviceNameForTests,
  setDeviceName,
} from "../device-name";
import { useDeviceSettingsSync } from "../useDeviceSettingsSync";

// Minimal in-memory localStorage, same approach as device-name.test.ts , jsdom
// on an opaque origin exposes none by default.
function installMemoryLocalStorage(): void {
  const map = new Map<string, string>();
  const fake = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
  vi.stubGlobal("localStorage", fake);
  Object.defineProperty(window, "localStorage", { value: fake, configurable: true });
}

const mutate = vi.fn();
const invalidate = vi.fn();
let queryData: { volume: number; name: string } | undefined;

vi.mock("../trpc", () => ({
  trpc: {
    useUtils: () => ({ deviceSettings: { get: { invalidate } } }),
    deviceSettings: {
      get: {
        useQuery: () => ({ data: queryData }),
      },
      set: {
        useMutation: () => ({ mutate }),
      },
    },
  },
}));

beforeEach(() => {
  installMemoryLocalStorage();
  resetDeviceNameForTests();
  mutate.mockReset();
  invalidate.mockReset();
  queryData = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDeviceSettingsSync , name migration", () => {
  it("pushes a pre-existing local name when the server has none yet, without clearing it locally", () => {
    setDeviceName("Calum's iPad");
    queryData = { volume: 0.5, name: "" };

    renderHook(() => useDeviceSettingsSync());

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { name: "Calum's iPad" } }),
      expect.anything(),
    );
    // The local name must survive the migration pass , it is the source of the
    // push, not something hydration is allowed to touch on the same tick.
    expect(isDeviceNameSet()).toBe(true);
  });

  it("marks migration resolved once the mutation settles, so a reload does not retry it", () => {
    setDeviceName("Calum's iPad");
    queryData = { volume: 0.5, name: "" };

    renderHook(() => useDeviceSettingsSync());
    expect(mutate).toHaveBeenCalledTimes(1);

    // Simulate the mutation settling.
    const onSettled = mutate.mock.calls[0]?.[1]?.onSettled;
    act(() => {
      onSettled?.();
    });

    expect(hasMigratedForTests()).toBe(true);
  });

  it("does not migrate when the server already has a name", () => {
    setDeviceName("Old Local Name");
    queryData = { volume: 0.5, name: "Server Name" };

    renderHook(() => useDeviceSettingsSync());

    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not migrate when no local name was ever set", () => {
    queryData = { volume: 0.5, name: "" };

    renderHook(() => useDeviceSettingsSync());

    expect(mutate).not.toHaveBeenCalled();
  });
});
