import { describe, expect, it } from "vitest";
import { MemorySessionMaintenanceStore, runSessionMaintenancePage } from "./session-maintenance";

describe("session maintenance", () => {
  it("deletes at most 500 expired sessions without exposing tokens", async () => {
    const store = new MemorySessionMaintenanceStore([
      ...Array.from({ length: 501 }, (_, index) => ({ token: `expired-${index}`, expiresAt: 99 })),
      { token: "active", expiresAt: 101 },
    ]);

    const first = await runSessionMaintenancePage({ store, now: 100, limit: 500 });
    expect(first).toEqual({ deleted: 500 });
    expect(JSON.stringify(first)).not.toContain("expired-");
    expect(store.has("active")).toBe(true);

    await expect(runSessionMaintenancePage({ store, now: 100, limit: 500 })).resolves.toEqual({
      deleted: 1,
    });
    await expect(runSessionMaintenancePage({ store, now: 100, limit: 500 })).resolves.toEqual({
      deleted: 0,
    });
  });
});
