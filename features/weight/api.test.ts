/**
 * Weight mutations against a mocked db — no Postgres needed. Verifies edits
 * preserve the raw reading behind a manual overlay and tombstones report the
 * truth instead of claiming success for a missing row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDbSelect, mockDbUpdate } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
}));

vi.mock("./db", () => ({
  db: { select: mockDbSelect, update: mockDbUpdate },
}));

import { router } from "@app-kit/server";
import type { TRPCError } from "@trpc/server";
import { weightRouter } from "./api";

function buildCaller() {
  const appRouter = router({ weight: weightRouter });
  return appRouter.createCaller({ db: null as never });
}

// Chainable update mock for db.update().set().where().returning().
function mockReturning(rows: unknown[]): void {
  mockDbUpdate.mockImplementation(() => ({
    set: () => ({
      where: () => ({
        returning: () => Promise.resolve(rows),
      }),
    }),
  }));
}

describe("weightRouter.delete", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns ok:true when a row is actually tombstoned", async () => {
    mockReturning([{ id: "wm_1" }]);
    const caller = buildCaller();
    await expect(caller.weight.delete({ id: "wm_1" })).resolves.toEqual({ ok: true });
  });

  it("throws NOT_FOUND rather than reporting success for a nonexistent row", async () => {
    mockReturning([]);
    const caller = buildCaller();
    await expect(caller.weight.delete({ id: "wm_missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    } satisfies Partial<TRPCError>);
  });
});

describe("weightRouter.edit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("stores a per-metric clear as an overlay and leaves source data untouched", async () => {
    mockDbSelect.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ overrides: { muscle_mass_kg: 55 } }]),
        }),
      }),
    }));
    let update: Record<string, unknown> | undefined;
    mockDbUpdate.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => {
        update = values;
        return { where: () => Promise.resolve() };
      },
    }));

    const caller = buildCaller();
    await expect(
      caller.weight.edit({ id: "wm_aug12", bodyMetrics: { fat_ratio_percent: null } }),
    ).resolves.toEqual({ ok: true });
    expect(update).toEqual({
      manualBodyMetricOverrides: { muscle_mass_kg: 55, fat_ratio_percent: null },
    });
  });

  it("throws NOT_FOUND for a missing or tombstoned reading", async () => {
    mockDbSelect.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }));
    const caller = buildCaller();
    await expect(
      caller.weight.edit({ id: "wm_missing", bodyMetrics: { fat_ratio_percent: null } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<TRPCError>);
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});
