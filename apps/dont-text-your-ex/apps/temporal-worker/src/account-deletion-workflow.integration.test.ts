import { createRequire } from "node:module";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AccountDeletionIdSchema } from "../../../contracts";

const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const testingEntry = require.resolve("@temporalio/testing");
const testingRequire = createRequire(testingEntry);
const { Worker } = await import(testingRequire.resolve("@temporalio/worker"));
const environments: TestWorkflowEnvironment[] = [];

afterEach(async () => {
  await Promise.all(environments.splice(0).map((environment) => environment.teardown()));
});

describe.sequential("AccountDeletionWorkflow Temporal integration", () => {
  it("runs the real workflow on main, preserves erasure ordering, and replays opaque history", async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    environments.push(environment);
    const deletionRequestId = AccountDeletionIdSchema.parse("del_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const calls: string[] = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath,
      activities: {
        terminateAssociatedWorkflows: async () => {
          calls.push("terminate");
          return { terminated: 2 };
        },
        eraseAccountLocally: async () => {
          calls.push("erase");
          return { erased: true as const };
        },
        recordAccountDeletionErasureStuck: async () => {
          calls.push("stuck");
          return { recorded: true as const };
        },
        revokeAppleCredential: async () => {
          calls.push("revoke");
          return { outcome: "revoked" as const };
        },
        finishAccountDeletion: async () => {
          calls.push("finish");
          return { state: "complete" as const };
        },
        deleteAssociatedWorkflowHistories: async () => {
          calls.push("delete_histories");
          return { deleted: 2 };
        },
      },
    });

    let history:
      | Awaited<
          ReturnType<ReturnType<typeof environment.client.workflow.getHandle>["fetchHistory"]>
        >
      | undefined;
    const result = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("AccountDeletionWorkflow", {
        workflowId: `deletion/${deletionRequestId}`,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        taskQueue: "main",
        args: [{ schemaVersion: 1, deletionRequestId }],
      });
      const output = await handle.result();
      history = await handle.fetchHistory();
      return output;
    });

    expect(result).toBe("complete");
    expect(calls).toEqual([
      "terminate",
      "erase",
      "terminate",
      "revoke",
      "finish",
      "delete_histories",
    ]);
    if (!history) throw new Error("workflow history missing");
    const inputPayloads =
      history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads;
    const historyInput = (inputPayloads ?? [])
      .map((payload) => new TextDecoder().decode(payload.data ?? undefined))
      .join("\n");
    expect(historyInput).toContain(deletionRequestId);
    expect(historyInput).not.toMatch(/apple|authorization|refresh|token|email|profile/i);
    await Worker.runReplayHistory({ workflowsPath }, history, `deletion/${deletionRequestId}`);
  }, 120_000);
});
