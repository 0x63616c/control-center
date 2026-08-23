import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  erase: vi.fn(async () => ({ erased: true as const })),
  revoke: vi.fn(async () => ({ outcome: "revoked" as const })),
  finish: vi.fn(async (input: { state: "complete" | "manual_action_required" }) => ({
    state: input.state,
  })),
  handlers: new Map<string, () => unknown>(),
  proxyOptions: [] as unknown[],
}));

vi.mock("@temporalio/workflow", () => ({
  defineQuery: (name: string) => name,
  setHandler: vi.fn((name: string, handler: () => unknown) => mocks.handlers.set(name, handler)),
  proxyActivities: (options: unknown) => {
    mocks.proxyOptions.push(options);
    return mocks.proxyOptions.length % 2 === 1
      ? { eraseAccountLocally: mocks.erase, finishAccountDeletion: mocks.finish }
      : { revokeAppleCredential: mocks.revoke };
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
  mocks.handlers.clear();
});

describe("AccountDeletionWorkflow", () => {
  it("finishes complete only after local erasure and Apple revocation", async () => {
    await expect(AccountDeletionWorkflow(input)).resolves.toBe("complete");
    expect(mocks.erase).toHaveBeenCalledWith({ deletionRequestId: input.deletionRequestId });
    expect(mocks.revoke).toHaveBeenCalledWith({ deletionRequestId: input.deletionRequestId });
    expect(mocks.finish).toHaveBeenCalledWith({
      deletionRequestId: input.deletionRequestId,
      state: "complete",
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

  it("rejects malformed opaque workflow input before touching storage", async () => {
    await expect(
      AccountDeletionWorkflow({ ...input, deletionRequestId: "usr_private" } as never),
    ).rejects.toThrow();
    expect(mocks.erase).not.toHaveBeenCalled();
  });
});
