import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToken, setToken } from "./api";
import { restoreSession, revokeCurrentSession } from "./session-lifecycle";

const TOKEN = "sess_testsession";
const USER = {
  id: "usr_session",
  name: "Session User",
  color: "#FF375F",
  emoji: null,
  photo: null,
  exes: [],
  phone: null,
} as const;

describe("frontend session lifecycle", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears a persisted token only when session restoration confirms a 401", async () => {
    setToken(TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "not_authenticated" }, { status: 401 })),
    );

    await expect(restoreSession()).resolves.toEqual({ status: "expired" });
    expect(getToken()).toBeNull();
  });

  it("keeps the token across network, server, and invalid-response failures before reload retry", async () => {
    setToken(TOKEN);
    const transientResponses = [
      vi.fn(async () => {
        throw new Error("network unavailable");
      }),
      vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })),
      vi.fn(async () => Response.json({ wrong: "shape" })),
    ];
    for (const fetchResponse of transientResponses) {
      vi.stubGlobal("fetch", fetchResponse);
      await expect(restoreSession()).resolves.toEqual({ status: "retry" });
      expect(getToken()).toBe(TOKEN);
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(USER)),
    );
    await expect(restoreSession()).resolves.toEqual({ status: "authenticated", user: USER });
    expect(getToken()).toBe(TOKEN);
  });

  it("keeps local auth after failed logout and clears it only after a successful retry", async () => {
    setToken(TOKEN);
    const revoke = vi
      .fn<() => Promise<{ ok: true }>>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ ok: true as const });

    await expect(revokeCurrentSession(revoke)).rejects.toThrow("network unavailable");
    expect(getToken()).toBe(TOKEN);

    await expect(revokeCurrentSession(revoke)).resolves.toBeUndefined();
    expect(getToken()).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
