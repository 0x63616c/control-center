import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  erase: vi.fn(async () => ({ erased: true as const })),
  revoke: vi.fn(async () => ({ outcome: "revoked" as const })),
  finish: vi.fn(async (input: { state: "complete" | "manual_action_required" }) => ({
    state: input.state,
  })),
  terminate: vi.fn(async () => ({ terminated: 0 })),
  deleteHistories: vi.fn(async () => ({ deleted: 0 })),
  recordStuck: vi.fn(async () => ({ recorded: true as const })),
  completedInsideTarget: true,
  handlers: new Map<string, () => unknown>(),
  proxyOptions: [] as unknown[],
}));

vi.mock("@temporalio/workflow", () => ({
  condition: vi.fn(async () => mocks.completedInsideTarget),
  defineQuery: (name: string) => name,
  setHandler: vi.fn((name: string, handler: () => unknown) => mocks.handlers.set(name, handler)),
  proxyActivities: (options: unknown) => {
    mocks.proxyOptions.push(options);
    const configuration = options as {
      startToCloseTimeout?: string;
      scheduleToCloseTimeout?: string;
    };
    if (configuration.startToCloseTimeout === "30 seconds") {
      return { revokeAppleCredential: mocks.revoke };
    }
    if (configuration.scheduleToCloseTimeout === "24 hours") {
      return {
        terminateAssociatedWorkflows: mocks.terminate,
        deleteAssociatedWorkflowHistories: mocks.deleteHistories,
      };
    }
    return {
      eraseAccountLocally: mocks.erase,
      finishAccountDeletion: mocks.finish,
      recordAccountDeletionErasureStuck: mocks.recordStuck,
    };
  },
}));

import { AccountDeletionWorkflow, accountDeletionStateQuery } from "./account-deletion-workflow";

const input = {
  schemaVersion: 1 as const,
  deletionRequestId: "del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never,
};

beforeEach(() => {
  mocks.erase.mockReset().mockResolvedValue({ erased: true });
  mocks.revoke.mockReset().mockResolvedValue({ outcome: "revoked" });
  mocks.finish.mockReset().mockImplementation(async ({ state }) => ({ state }));
  mocks.terminate.mockReset().mockResolvedValue({ terminated: 0 });
  mocks.deleteHistories.mockReset().mockResolvedValue({ deleted: 0 });
  mocks.recordStuck.mockReset().mockResolvedValue({ recorded: true });
  mocks.completedInsideTarget = true;
  mocks.handlers.clear();
});

describe("AccountDeletionWorkflow", () => {
  it("never caps retries before Postgres proves local erasure", () => {
    const localOptions = mocks.proxyOptions.find(
      (value) => (value as { startToCloseTimeout?: string }).startToCloseTimeout === "2 minutes",
    ) as { retry?: { maximumAttempts?: number } } | undefined;

    expect(localOptions?.retry?.maximumAttempts).toBeUndefined();
  });

  it("finishes complete only after local erasure and Apple revocation", async () => {
    await expect(AccountDeletionWorkflow(input)).resolves.toBe("complete");
    expect(mocks.terminate).toHaveBeenCalledTimes(2);
    expect(mocks.terminate).toHaveBeenCalledWith({ deletionRequestId: input.deletionRequestId });
    expect(mocks.erase).toHaveBeenCalledWith({ deletionRequestId: input.deletionRequestId });
    expect(mocks.revoke).toHaveBeenCalledWith({ deletionRequestId: input.deletionRequestId });
    expect(mocks.finish).toHaveBeenCalledWith({
      deletionRequestId: input.deletionRequestId,
      state: "complete",
    });
    expect(mocks.deleteHistories).toHaveBeenCalledWith({
      deletionRequestId: input.deletionRequestId,
    });
    expect(accountDeletionStateQuery).toBe("accountDeletionState");
    expect(mocks.handlers.get("accountDeletionState")?.()).toBe("complete");
  });

  it("finishes manual_action_required after the bounded Apple retry window is exhausted", async () => {
    mocks.revoke.mockRejectedValue(new Error("Apple unavailable after retry window"));

    await expect(AccountDeletionWorkflow(input)).resolves.toBe("manual_action_required");
    expect(mocks.finish).toHaveBeenCalledWith({
      deletionRequestId: input.deletionRequestId,
      state: "manual_action_required",
    });
  });

  it("records a privacy-safe stuck signal after local erasure exceeds fifteen minutes", async () => {
    mocks.completedInsideTarget = false;

    await expect(AccountDeletionWorkflow(input)).resolves.toBe("complete");

    expect(mocks.recordStuck).toHaveBeenCalledWith({
      deletionRequestId: input.deletionRequestId,
    });
  });

  it("rejects malformed opaque workflow input before touching storage", async () => {
    await expect(
      AccountDeletionWorkflow({ ...input, deletionRequestId: "usr_private" } as never),
    ).rejects.toThrow();
    expect(mocks.erase).not.toHaveBeenCalled();
  });
});
