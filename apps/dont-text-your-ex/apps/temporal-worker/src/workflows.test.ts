import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activity: vi.fn(async (_input: { readonly iteration: number }) => ({ status: "ok" as const })),
  sleep: vi.fn(async () => undefined),
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({ DtyeHealthCheckActivity: mocks.activity }),
  sleep: mocks.sleep,
}));

import { DtyeHealthCheckWorkflow } from "./workflows";

describe("DtyeHealthCheckWorkflow", () => {
  beforeEach(() => {
    mocks.activity.mockClear();
    mocks.sleep.mockClear();
  });

  test("runs exactly five checks and returns the locked terminal result", async () => {
    await expect(DtyeHealthCheckWorkflow({ schemaVersion: 1 })).resolves.toEqual({
      status: "healthy",
      checks: 5,
    });
    expect(mocks.activity).toHaveBeenCalledTimes(5);
    expect(mocks.activity.mock.calls.map(([input]) => input)).toEqual([
      { iteration: 0 },
      { iteration: 1 },
      { iteration: 2 },
      { iteration: 3 },
      { iteration: 4 },
    ]);
  });

  test("rejects an incompatible input schema before running an activity", async () => {
    await expect(DtyeHealthCheckWorkflow({ schemaVersion: 2 } as never)).rejects.toThrow(
      "unsupported health workflow schema",
    );
    expect(mocks.activity).not.toHaveBeenCalled();
  });
});
