import { describe, expect, test, vi } from "vitest";
import { PostgresOutboxOperationalSnapshotStore } from "./operations-observability";

describe("outbox operational snapshot", () => {
  test("maps one aggregate SQL row to bounded gauges and clamps clock skew", async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{ pending: "4", oldest_occurred_at: "12000", permanent_failures: "2" }],
    }));
    const store = new PostgresOutboxOperationalSnapshotStore({ query } as never);
    await expect(store.snapshot(10_000)).resolves.toEqual({
      pending: 4,
      oldestAgeSeconds: 0,
      permanentFailures: 2,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).not.toMatch(/aggregate_id|event_type|claim_owner/);
  });

  test("reports an empty queue with zero age", async () => {
    const store = new PostgresOutboxOperationalSnapshotStore({
      query: vi.fn(async () => ({
        rows: [{ pending: "0", oldest_occurred_at: null, permanent_failures: "0" }],
      })),
    } as never);
    await expect(store.snapshot(10_000)).resolves.toEqual({
      pending: 0,
      oldestAgeSeconds: 0,
      permanentFailures: 0,
    });
  });
});
