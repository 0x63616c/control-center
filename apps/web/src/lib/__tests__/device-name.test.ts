import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveDefaultName,
  getDeviceName,
  hasMigratedForTests,
  hydrateDeviceName,
  isDeviceNameSet,
  markDeviceNameMigrated,
  nameToMigrate,
  resetDeviceNameForTests,
  setDeviceName,
} from "../device-name";
import { getTail, log } from "../log/logger";

const USER_KEY = "cc-device-name";
const AUTO_KEY = "cc-device-name-auto";

// jsdom on an opaque origin (about:blank) exposes no localStorage, so the store
// would fall back to its no-storage path and nothing would persist. Install a
// minimal in-memory Storage so these tests exercise the real persistence logic.
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

beforeEach(() => {
  installMemoryLocalStorage();
  resetDeviceNameForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deriveDefaultName", () => {
  it("names iPads / iPhones from the user agent", () => {
    expect(deriveDefaultName("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari")).toBe("iPad");
    expect(deriveDefaultName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari")).toBe("iPhone");
  });

  it("names desktop browsers as browser-OS slugs", () => {
    expect(
      deriveDefaultName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Chrome/120.0 Safari/537.36",
        "MacIntel",
      ),
    ).toBe("Chrome-macOS");
    expect(
      deriveDefaultName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/121.0",
        "Win32",
      ),
    ).toBe("Firefox-Windows");
  });

  it("falls back to a real, non-empty string when nothing is known", () => {
    expect(deriveDefaultName("", "")).toBe("unknown-device");
  });
});

describe("device name store", () => {
  it("is not set before the user chooses one", () => {
    expect(isDeviceNameSet()).toBe(false);
  });

  it("returns a non-empty auto default when unset, persisted under its own key", () => {
    const name = getDeviceName();
    expect(name).not.toBe("");
    expect(localStorage.getItem(AUTO_KEY)).toBe(name);
    // The user key stays absent , the default lives under a separate key so
    // "user has not chosen one" remains independently detectable.
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(isDeviceNameSet()).toBe(false);
  });

  it("returns the user value once set, and reports isSet", () => {
    setDeviceName("Calum's Laptop");
    expect(getDeviceName()).toBe("Calum's Laptop");
    expect(isDeviceNameSet()).toBe(true);
    expect(localStorage.getItem(USER_KEY)).toBe("Calum's Laptop");
  });

  it("clears back to the auto default (and re-shows as unset) on empty/whitespace input", () => {
    setDeviceName("iPad");
    expect(isDeviceNameSet()).toBe(true);
    const auto = localStorage.getItem(AUTO_KEY);

    setDeviceName("   ");
    expect(isDeviceNameSet()).toBe(false);
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(getDeviceName()).toBe(auto);
  });

  it("keeps the auto default stable across a simulated reload", () => {
    const first = getDeviceName();
    // Simulate a reload: drop the in-memory cache, keep localStorage.
    resetDeviceNameForTests();
    expect(getDeviceName()).toBe(first);
    expect(localStorage.getItem(AUTO_KEY)).toBe(first);
  });
});

describe("nameToMigrate (ticket #63 upward migration)", () => {
  it("returns the pre-existing local name when the server has none yet", () => {
    setDeviceName("Calum's Laptop");
    expect(nameToMigrate("")).toBe("Calum's Laptop");
  });

  it("does not mark migrated on its own , the caller marks it once the push settles", () => {
    setDeviceName("Calum's Laptop");
    nameToMigrate("");
    expect(hasMigratedForTests()).toBe(false);
  });

  it("truncates an over-length legacy name to NAME_MAX_LENGTH", () => {
    const long = "x".repeat(120);
    setDeviceName(long);
    const result = nameToMigrate("");
    expect(result).not.toBeNull();
    expect(result?.length).toBe(60);
  });

  it("returns null and marks migrated when the server already has a name", () => {
    setDeviceName("Old Local Name");
    expect(nameToMigrate("Server Name")).toBeNull();
    expect(hasMigratedForTests()).toBe(true);
  });

  it("returns null and marks migrated when no local name was ever set", () => {
    expect(nameToMigrate("")).toBeNull();
    expect(hasMigratedForTests()).toBe(true);
  });

  it("returns null once already migrated, even if conditions would otherwise match", () => {
    setDeviceName("Calum's Laptop");
    markDeviceNameMigrated();
    expect(nameToMigrate("")).toBeNull();
  });
});

describe("markDeviceNameMigrated / hasMigratedForTests persistence", () => {
  it("persists across a simulated reload", () => {
    expect(hasMigratedForTests()).toBe(false);
    markDeviceNameMigrated();
    resetDeviceNameForTests();
    expect(hasMigratedForTests()).toBe(true);
  });
});

describe("hydrateDeviceName", () => {
  it("adopts a non-empty server value", () => {
    hydrateDeviceName("Server Name");
    expect(getDeviceName()).toBe("Server Name");
    expect(isDeviceNameSet()).toBe(true);
  });

  it("ignores an empty server value (that's the migration's job, not hydration's)", () => {
    setDeviceName("Local Name");
    hydrateDeviceName("");
    expect(getDeviceName()).toBe("Local Name");
  });

  it("is a no-op when the server value already matches the local one", () => {
    setDeviceName("Same Name");
    hydrateDeviceName("Same Name");
    expect(getDeviceName()).toBe("Same Name");
  });
});

describe("logger stamps deviceName", () => {
  it("tags each write with the current device name, following name changes", () => {
    setDeviceName("iPad");
    const before = getTail().length;
    log.info("first line");
    const first = getTail()[before];
    expect(first?.deviceName).toBe("iPad");
    expect(first?.deviceName).toBe(getDeviceName());

    setDeviceName("iPad-2");
    log.info("second line");
    const second = getTail()[before + 1];
    expect(second?.deviceName).toBe("iPad-2");
  });
});
