import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sweep: vi.fn(async () => ({ deleted: 2 })),
  purge: vi.fn(async () => ({ deleted: 1 })),
}));
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({
    sweepAccountDeletionHistories: mocks.sweep,
    purgeExpiredAccountDeletionRecords: mocks.purge,
  }),
}));

import { AccountDeletionHistorySweepWorkflow } from "./account-deletion-history-sweep";

describe("AccountDeletionHistorySweepWorkflow", () => {
  it("only sweeps terminal deletion histories after a settle delay", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await expect(AccountDeletionHistorySweepWorkflow({ schemaVersion: 1 })).resolves.toEqual({
      deleted: 2,
      purged: 1,
    });
    expect(mocks.sweep).toHaveBeenCalledWith({ terminalBefore: 700_000, limit: 100 });
    expect(mocks.purge).toHaveBeenCalledWith({ expiredBefore: 1_000_000, limit: 100 });
  });

  it("rejects unknown schemas", async () => {
    await expect(
      AccountDeletionHistorySweepWorkflow({ schemaVersion: 2 } as never),
    ).rejects.toThrow(/unsupported account deletion sweep schema/);
  });
});
