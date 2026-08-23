import type { Client } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { AccountDeletionIdSchema } from "../../../contracts";
import {
  createAccountDeletionActivities,
  TemporalAccountDeletionWorkflowCleanupGateway,
} from "./account-deletion";

const deletionRequestId = AccountDeletionIdSchema.parse("del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const workflowFence = {
  withCleanupFence: async <T>(_workflowId: string, effect: () => Promise<T>) => effect(),
};

describe("account deletion activities", () => {
  it("erases locally before exchanging and revoking a fresh Apple credential", async () => {
    const observeErasureStuck = vi.fn();
    const store = {
      eraseLocally: vi.fn(async () => undefined),
      loadRefreshToken: vi.fn(async () => null),
      loadAppleRevocationCredential: vi.fn(async () => ({
        authorizationCode: "fresh-code",
        expectedSubject: "apple-subject",
      })),
      saveRefreshToken: vi.fn(async () => undefined),
      markTerminal: vi.fn(async () => undefined),
      listAssociatedWorkflowIds: vi.fn(async () => []),
      markCleanupState: vi.fn(async () => undefined),
      listTerminalDeletionWorkflows: vi.fn(async () => []),
      purgeExpiredRecords: vi.fn(async () => ({ deleted: 0 })),
    };
    const apple = {
      exchangeAuthorizationCode: vi.fn(async () => ({ refreshToken: "refresh-token" })),
      revokeRefreshToken: vi.fn(async () => undefined),
    };
    const activities = createAccountDeletionActivities({
      store,
      apple,
      workflows: { terminate: vi.fn(), deleteHistory: vi.fn() },
      observeErasureStuck,
      workflowFence,
    });

    await expect(activities.eraseAccountLocally({ deletionRequestId })).resolves.toEqual({
      erased: true,
    });
    await expect(activities.revokeAppleCredential({ deletionRequestId })).resolves.toEqual({
      outcome: "revoked",
    });
    expect(apple.exchangeAuthorizationCode).toHaveBeenCalledWith("fresh-code", "apple-subject");
    expect(store.saveRefreshToken).toHaveBeenCalledWith(deletionRequestId, "refresh-token");
    expect(apple.revokeRefreshToken).toHaveBeenCalledWith("refresh-token");
    await expect(
      activities.recordAccountDeletionErasureStuck({ deletionRequestId }),
    ).resolves.toEqual({ recorded: true });
    expect(observeErasureStuck).toHaveBeenCalledOnce();
  });

  it("reuses the durable refresh token after a failed revocation attempt", async () => {
    const store = {
      eraseLocally: vi.fn(),
      loadRefreshToken: vi.fn(async () => "saved-refresh"),
      loadAppleRevocationCredential: vi.fn(),
      saveRefreshToken: vi.fn(),
      markTerminal: vi.fn(async () => undefined),
      listAssociatedWorkflowIds: vi.fn(async () => []),
      markCleanupState: vi.fn(async () => undefined),
      listTerminalDeletionWorkflows: vi.fn(async () => []),
      purgeExpiredRecords: vi.fn(async () => ({ deleted: 0 })),
    };
    const apple = {
      exchangeAuthorizationCode: vi.fn(),
      revokeRefreshToken: vi.fn(async () => undefined),
    };
    const activities = createAccountDeletionActivities({
      store,
      apple,
      workflows: { terminate: vi.fn(), deleteHistory: vi.fn() },
      observeErasureStuck: vi.fn(),
      workflowFence,
    });

    await expect(activities.revokeAppleCredential({ deletionRequestId })).resolves.toEqual({
      outcome: "revoked",
    });
    expect(store.loadAppleRevocationCredential).not.toHaveBeenCalled();
    expect(apple.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(apple.revokeRefreshToken).toHaveBeenCalledWith("saved-refresh");
  });

  it("requires manual Apple action when no revocation credential exists and destroys secrets at terminal state", async () => {
    const store = {
      eraseLocally: vi.fn(),
      loadRefreshToken: vi.fn(async () => null),
      loadAppleRevocationCredential: vi.fn(async () => null),
      saveRefreshToken: vi.fn(),
      markTerminal: vi.fn(async () => undefined),
      listAssociatedWorkflowIds: vi.fn(async () => []),
      markCleanupState: vi.fn(async () => undefined),
      listTerminalDeletionWorkflows: vi.fn(async () => []),
      purgeExpiredRecords: vi.fn(async () => ({ deleted: 0 })),
    };
    const activities = createAccountDeletionActivities({
      store,
      apple: { exchangeAuthorizationCode: vi.fn(), revokeRefreshToken: vi.fn() },
      workflows: { terminate: vi.fn(), deleteHistory: vi.fn() },
      observeErasureStuck: vi.fn(),
      workflowFence,
    });

    await expect(activities.revokeAppleCredential({ deletionRequestId })).resolves.toEqual({
      outcome: "manual_action_required",
    });
    await expect(
      activities.finishAccountDeletion({ deletionRequestId, state: "manual_action_required" }),
    ).resolves.toEqual({ state: "manual_action_required" });
    expect(store.markTerminal).toHaveBeenCalledWith(deletionRequestId, "manual_action_required");
  });

  it("terminates inventoried account workflows before erasure and deletes their histories afterward", async () => {
    const store = {
      eraseLocally: vi.fn(),
      loadRefreshToken: vi.fn(),
      loadAppleRevocationCredential: vi.fn(),
      saveRefreshToken: vi.fn(),
      markTerminal: vi.fn(),
      listAssociatedWorkflowIds: vi
        .fn()
        .mockResolvedValueOnce(["report/rpt_a", "rescue/rsi_a"])
        .mockResolvedValueOnce(["report/rpt_a", "rescue/rsi_a"]),
      markCleanupState: vi.fn(async () => undefined),
      listTerminalDeletionWorkflows: vi.fn(async () => []),
      purgeExpiredRecords: vi.fn(async () => ({ deleted: 0 })),
    };
    const workflows = {
      terminate: vi.fn(async () => undefined),
      deleteHistory: vi.fn(async () => undefined),
    };
    const activities = createAccountDeletionActivities({
      store,
      apple: { exchangeAuthorizationCode: vi.fn(), revokeRefreshToken: vi.fn() },
      workflows,
      observeErasureStuck: vi.fn(),
      workflowFence,
    });

    await activities.terminateAssociatedWorkflows({ deletionRequestId });
    await activities.deleteAssociatedWorkflowHistories({ deletionRequestId });

    expect(workflows.terminate.mock.calls).toEqual([["report/rpt_a"], ["rescue/rsi_a"]]);
    expect(workflows.deleteHistory.mock.calls).toEqual([["report/rpt_a"], ["rescue/rsi_a"]]);
    expect(store.markCleanupState.mock.calls).toEqual([
      [deletionRequestId, "report/rpt_a", "terminated"],
      [deletionRequestId, "rescue/rsi_a", "terminated"],
      [deletionRequestId, "report/rpt_a", "deleted"],
      [deletionRequestId, "rescue/rsi_a", "deleted"],
    ]);
  });

  it("deletes terminal account-deletion workflow histories from the external sweeper", async () => {
    const deletionRequestIdB = AccountDeletionIdSchema.parse(
      "del_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    const store = {
      eraseLocally: vi.fn(),
      loadRefreshToken: vi.fn(),
      loadAppleRevocationCredential: vi.fn(),
      saveRefreshToken: vi.fn(),
      markTerminal: vi.fn(),
      listAssociatedWorkflowIds: vi.fn(),
      markCleanupState: vi.fn(async () => undefined),
      listTerminalDeletionWorkflows: vi.fn(async () => [
        { deletionRequestId, workflowId: `deletion/${deletionRequestId}` },
        { deletionRequestId: deletionRequestIdB, workflowId: `deletion/${deletionRequestIdB}` },
      ]),
      purgeExpiredRecords: vi.fn(async () => ({ deleted: 0 })),
    };
    const deleteHistory = vi.fn(async () => undefined);
    const activities = createAccountDeletionActivities({
      store,
      apple: { exchangeAuthorizationCode: vi.fn(), revokeRefreshToken: vi.fn() },
      workflows: { terminate: vi.fn(), deleteHistory },
      observeErasureStuck: vi.fn(),
      workflowFence,
    });

    await expect(
      activities.sweepAccountDeletionHistories({ terminalBefore: 10_000, limit: 100 }),
    ).resolves.toEqual({ deleted: 2 });
    store.purgeExpiredRecords.mockResolvedValueOnce({ deleted: 1 });
    await expect(
      activities.purgeExpiredAccountDeletionRecords({ expiredBefore: 20_000, limit: 100 }),
    ).resolves.toEqual({ deleted: 1 });
    expect(store.purgeExpiredRecords).toHaveBeenCalledWith(20_000, 100);
    expect(deleteHistory).toHaveBeenCalledTimes(2);
    expect(store.markCleanupState).toHaveBeenLastCalledWith(
      deletionRequestIdB,
      `deletion/${deletionRequestIdB}`,
      "deleted",
    );
  });
});

describe("Temporal account deletion workflow cleanup", () => {
  it("accepts a failed termination only after Temporal verifies the execution is closed", async () => {
    const terminate = vi.fn(async () => {
      throw Object.assign(new Error("workflow execution already completed"), { code: 9 });
    });
    const describeExecution = vi.fn(async () => ({ status: { name: "COMPLETED" } }));
    const client = {
      workflow: {
        getHandle: vi.fn(() => ({ terminate, describe: describeExecution })),
        options: { namespace: "dont-text-your-ex" },
      },
      workflowService: { deleteWorkflowExecution: vi.fn() },
    } as unknown as Client;
    const gateway = new TemporalAccountDeletionWorkflowCleanupGateway(client);

    await expect(gateway.terminate("report/rpt_complete")).resolves.toBeUndefined();
    expect(describeExecution).toHaveBeenCalledOnce();
  });

  it("preserves a termination failure when Temporal reports the execution is still running", async () => {
    const terminationError = Object.assign(new Error("termination rejected"), { code: 9 });
    const terminate = vi.fn(async () => {
      throw terminationError;
    });
    const describeExecution = vi.fn(async () => ({ status: { name: "RUNNING" } }));
    const client = {
      workflow: {
        getHandle: vi.fn(() => ({ terminate, describe: describeExecution })),
        options: { namespace: "dont-text-your-ex" },
      },
      workflowService: { deleteWorkflowExecution: vi.fn() },
    } as unknown as Client;
    const gateway = new TemporalAccountDeletionWorkflowCleanupGateway(client);

    await expect(gateway.terminate("report/rpt_running")).rejects.toBe(terminationError);
    expect(describeExecution).toHaveBeenCalledOnce();
  });
});
