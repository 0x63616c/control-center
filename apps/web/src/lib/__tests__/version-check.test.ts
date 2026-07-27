import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELOAD_GRACE_MS, startVersionCheck, VERSION_POLL_MS } from "../version-check";

// Tests below pass reloadDelay: 0 wherever the grace period itself isn't
// under test, so the existing "reload fires on this tick" assertions don't
// all need to grow an extra advance.

// Builds a fetch mock that resolves to a version.json carrying `hash`.
function fetchReturning(hash: string) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ hash }),
  })) as unknown as typeof fetch;
}

describe("startVersionCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("reloads exactly once when the fetched SHA differs from the running one", async () => {
    const reload = vi.fn();
    const fetchMock = fetchReturning("new-sha");
    vi.stubGlobal("fetch", fetchMock);

    startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: 0 });

    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS + 1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the fetched SHA matches the running one", async () => {
    const reload = vi.fn();
    vi.stubGlobal("fetch", fetchReturning("same-sha"));

    startVersionCheck({ currentHash: "same-sha", reload, reloadDelay: 0 });

    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 3);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload again after the first mismatch (loop guard)", async () => {
    const reload = vi.fn();
    vi.stubGlobal("fetch", fetchReturning("new-sha"));

    startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: 0 });

    // Several ticks elapse before the slow reload navigates away.
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 4);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("swallows a rejected fetch and keeps polling", async () => {
    const reload = vi.fn();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, json: async () => ({ hash: "new-sha" }) });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: 0 });

    // First tick rejects (no throw, no reload).
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    expect(reload).not.toHaveBeenCalled();

    // Next tick succeeds with a mismatch and reloads.
    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS + 1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("swallows a 404 (no version.json yet) without reloading", async () => {
    const reload = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );

    startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: 0 });

    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 2);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores malformed json with no string hash", async () => {
    const reload = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ hash: 123 }),
      })) as unknown as typeof fetch,
    );

    startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: 0 });

    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not poll in local dev (hash 'dev')", async () => {
    const reload = vi.fn();
    const fetchMock = fetchReturning("new-sha");
    vi.stubGlobal("fetch", fetchMock);

    const stop = startVersionCheck({ currentHash: "dev", reload, reloadDelay: 0 });

    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 3);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    stop();
  });

  it("re-checks immediately when the page becomes visible", async () => {
    const reload = vi.fn();
    vi.stubGlobal("fetch", fetchReturning("new-sha"));

    startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: 0 });

    // Fire visibilitychange without advancing the poll timer.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("re-checks immediately when the network comes back online", async () => {
    const reload = vi.fn();
    vi.stubGlobal("fetch", fetchReturning("new-sha"));

    startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: 0 });

    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the interval and detaches listeners", async () => {
    const reload = vi.fn();
    const fetchMock = fetchReturning("new-sha");
    vi.stubGlobal("fetch", fetchMock);

    const stop = startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: 0 });
    stop();

    await vi.advanceTimersByTimeAsync(VERSION_POLL_MS * 3);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);

    expect(reload).not.toHaveBeenCalled();
  });

  it("waits reloadDelay before reloading, so a return-from-modal visibility check doesn't reload instantly", async () => {
    const reload = vi.fn();
    vi.stubGlobal("fetch", fetchReturning("new-sha"));

    startVersionCheck({ currentHash: "old-sha", reload, reloadDelay: RELOAD_GRACE_MS });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    // Mismatch detected, but the grace period hasn't elapsed yet.
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(RELOAD_GRACE_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
