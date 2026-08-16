import { createRequire } from "node:module";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterEach, describe, expect, it } from "vitest";
import { InviteVersionIdSchema } from "../../api/src/domain-events";
import { inviteStateQuery, inviteSupersededSignal } from "./invite-workflow";

const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;
const require = createRequire(import.meta.url);
const testingEntry = require.resolve("@temporalio/testing");
const testingRequire = createRequire(testingEntry);
const { Worker } = await import(testingRequire.resolve("@temporalio/worker"));
const environments: TestWorkflowEnvironment[] = [];
const DAY_MS = 86_400_000;

afterEach(async () => {
  await Promise.all(environments.splice(0).map((environment) => environment.teardown()));
});

describe.sequential("InviteLifecycleWorkflow Temporal integration", () => {
  it("crosses the durable reminder timer and replays history containing only the version id", async () => {
    const environment = await TestWorkflowEnvironment.createTimeSkipping();
    environments.push(environment);
    const inviteVersionId = InviteVersionIdSchema.parse("inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const startedAt = await environment.currentTimeMs();
    const requestInputs: unknown[] = [];
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath,
      activities: {
        loadInviteLifecycle: async () => ({
          kind: "eligible" as const,
          expiresAt: startedAt + 3 * DAY_MS,
        }),
        requestInviteReminder: async (input: unknown) => {
          requestInputs.push(input);
          return { kind: "reminded" as const };
        },
      },
    });

    let history:
      | Awaited<
          ReturnType<ReturnType<typeof environment.client.workflow.getHandle>["fetchHistory"]>
        >
      | undefined;
    const result = await worker.runUntil(async () => {
      const handle = await environment.client.workflow.start("InviteLifecycleWorkflow", {
        workflowId: `invite/${inviteVersionId}`,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        taskQueue: "main",
        args: [{ schemaVersion: 1, inviteVersionId }],
      });
      const output = await handle.result();
      history = await handle.fetchHistory();
      return output;
    });

    expect(result).toBe("reminded");
    expect(requestInputs).toEqual([{ inviteVersionId }]);
    expect((await environment.currentTimeMs()) - startedAt).toBeGreaterThanOrEqual(2 * DAY_MS);
    if (!history) throw new Error("workflow history missing");
    const startPayloads =
      history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads;
    const historyInput = (startPayloads ?? [])
      .map((payload) => new TextDecoder().decode(payload.data ?? undefined))
      .join("\n");
    expect(historyInput).toContain(inviteVersionId);
    expect(historyInput).not.toMatch(/invite_code|https?:\/\/|join\//i);
    await Worker.runReplayHistory({ workflowsPath }, history, `invite/${inviteVersionId}`);
  }, 120_000);

  it("resumes an open lifecycle on a replacement polling worker", async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    environments.push(environment);
    const inviteVersionId = InviteVersionIdSchema.parse("inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    let authoritativeState:
      | { readonly kind: "eligible"; readonly expiresAt: number }
      | { readonly kind: "superseded" } = {
      kind: "eligible",
      expiresAt: Date.now() + 7 * DAY_MS,
    };
    let markLoaded: (() => void) | undefined;
    const loaded = new Promise<void>((resolve) => {
      markLoaded = resolve;
    });
    const workerOptions = {
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "main",
      workflowsPath,
      activities: {
        loadInviteLifecycle: async () => {
          markLoaded?.();
          return authoritativeState;
        },
        requestInviteReminder: async () => authoritativeState,
      },
    };
    const firstWorker = await Worker.create(workerOptions);
    let handle: Awaited<ReturnType<typeof environment.client.workflow.start>> | undefined;

    await firstWorker.runUntil(async () => {
      handle = await environment.client.workflow.start("InviteLifecycleWorkflow", {
        workflowId: `invite-restart/${inviteVersionId}`,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        taskQueue: "main",
        args: [{ schemaVersion: 1, inviteVersionId }],
      });
      await loaded;
      let state = await handle.query(inviteStateQuery);
      while (state !== "waiting") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        state = await handle.query(inviteStateQuery);
      }
    });
    if (!handle) throw new Error("workflow handle missing");
    const activeHandle = handle;

    authoritativeState = { kind: "superseded" };
    await activeHandle.signal(inviteSupersededSignal, {
      schemaVersion: 1,
      inviteVersionId,
      expectedAggregateVersion: 2,
    });
    const replacementWorker = await Worker.create(workerOptions);

    await expect(replacementWorker.runUntil(() => activeHandle.result())).resolves.toBe(
      "superseded",
    );
  }, 60_000);
});
