/**
 * Tests for the store-driven `heartbeat` + `runCycle` helpers. Ported from the
 * former apps/api `integration-heartbeat.test.ts`, but driven by an in-memory
 * `IntegrationSyncStore` instead of a mocked db (assert via `store.read` and the
 * returned streak).
 */
import { describe, expect, it, vi } from "vitest";

import { heartbeat, runCycle } from "../src/integration-sync/heartbeat";
import { createInMemoryIntegrationSyncStore } from "../src/integration-sync/memory";

describe("heartbeat", () => {
  it("ok() records lastError null and resets the streak to 0", async () => {
    const store = createInMemoryIntegrationSyncStore();

    await heartbeat(store, "light-enforcer").ok();

    const row = await store.read("light-enforcer");
    expect(row?.lastError).toBeNull();
    expect(row?.consecutiveFailures).toBe(0);
  });

  it("fail() increments the prior streak and returns the new value", async () => {
    const store = createInMemoryIntegrationSyncStore();
    await store.recordFail("weather", "prior");
    await store.recordFail("weather", "prior");

    const streak = await heartbeat(store, "weather").fail("HA down");

    expect(streak).toBe(3);
    const row = await store.read("weather");
    expect(row?.lastError).toBe("HA down");
    expect(row?.consecutiveFailures).toBe(3);
  });

  it("fail() treats a missing prior row as streak 0 (first failure -> 1)", async () => {
    const store = createInMemoryIntegrationSyncStore();

    expect(await heartbeat(store, "weather").fail("boom")).toBe(1);
  });
});

describe("runCycle", () => {
  it("runs the work and marks the heartbeat ok on success", async () => {
    const store = createInMemoryIntegrationSyncStore();
    const work = vi.fn().mockResolvedValue(undefined);

    await runCycle(heartbeat(store, "device-sync"), "device-sync", work);

    expect(work).toHaveBeenCalledOnce();
    const row = await store.read("device-sync");
    expect(row?.lastError).toBeNull();
    expect(row?.consecutiveFailures).toBe(0);
  });

  it("records the heartbeat failure BEFORE rethrowing the original error", async () => {
    const store = createInMemoryIntegrationSyncStore();
    await store.recordFail("device-sync", "prior");
    const work = vi.fn().mockRejectedValue(new Error("kaboom"));

    // The heartbeat write is a store side effect independent of the rejection ,
    // assert it landed, not just that the promise eventually rejects, so a
    // regression that reorders fail()-after-throw (losing the streak) would be
    // caught even though "rejects" alone wouldn't notice.
    await expect(runCycle(heartbeat(store, "device-sync"), "device-sync", work)).rejects.toThrow(
      "kaboom",
    );

    const row = await store.read("device-sync");
    expect(row?.lastError).toBe("kaboom");
    expect(row?.consecutiveFailures).toBe(2);
  });

  it("rethrows the exact original error instance (not a wrapped one)", async () => {
    const store = createInMemoryIntegrationSyncStore();
    const original = new Error("boom");
    const work = vi.fn().mockRejectedValue(original);

    await expect(runCycle(heartbeat(store, "device-sync"), "device-sync", work)).rejects.toBe(
      original,
    );
  });
});
