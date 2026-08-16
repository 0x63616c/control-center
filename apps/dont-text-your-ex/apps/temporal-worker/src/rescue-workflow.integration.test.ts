import { createRequire } from "node:module";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RescueIntervention,
  RescueInterventionIdSchema,
  RescueInterventionSchema,
} from "../../../contracts";
import {
  extendRescueSignal,
  rescueAccountDeletedSignal,
  rescueStateQuery,
  safeRescueSignal,
  slippedRescueSignal,
  UrgeRescueWorkflow,
} from "./workflows";

const interventionId = RescueInterventionIdSchema.parse("rsi_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const workflowsPath = new URL("./workflows.ts", import.meta.url).pathname;
// Bun currently installs the test package's exact Temporal worker dependency
// beneath that package. Loading the same copy avoids two protobuf registries in
// one Vitest process while keeping every Temporal SDK package on 1.21.1.
const require = createRequire(import.meta.url);
const testingEntry = require.resolve("@temporalio/testing");
const testingRequire = createRequire(testingEntry);
const { Worker } = await import(testingRequire.resolve("@temporalio/worker"));
const environments: TestWorkflowEnvironment[] = [];

afterEach(async () => {
  await Promise.all(environments.splice(0).map((environment) => environment.teardown()));
});

function active(startedAt: number, extensionCount = 0, aggregateVersion = 1) {
  return RescueInterventionSchema.parse({
    id: interventionId,
    status: "active",
    startedAt,
    deadlineAt: startedAt + (extensionCount + 1) * 10 * 60_000,
    extensionCount,
    aggregateVersion,
    updatedAt: startedAt,
  });
}

async function testWorker(initial: RescueIntervention) {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  environments.push(environment);
  let state: RescueIntervention | null = initial;
  const advanceCalls: number[] = [];
  let eraseCalls = 0;
  const activities = {
    loadRescue: async () => state,
    advanceRescueAtDeadline: async ({
      expectedAggregateVersion,
    }: {
      expectedAggregateVersion: number;
    }) => {
      advanceCalls.push(expectedAggregateVersion);
      if (!state || state.aggregateVersion !== expectedAggregateVersion) return state;
      if (state.status === "active") {
        if (state.deadlineAt >= state.startedAt + 30 * 60_000) {
          state = RescueInterventionSchema.parse({
            ...state,
            status: "abandoned",
            aggregateVersion: state.aggregateVersion + 1,
            resolvedAt: state.deadlineAt,
            updatedAt: state.deadlineAt,
          });
        } else {
          state = RescueInterventionSchema.parse({
            ...state,
            status: "check_in_due",
            aggregateVersion: state.aggregateVersion + 1,
            checkInDueAt: state.deadlineAt,
            responseDeadlineAt: state.deadlineAt + 5 * 60_000,
            updatedAt: state.deadlineAt,
          });
        }
      } else if (state.status === "check_in_due") {
        state = RescueInterventionSchema.parse({
          id: state.id,
          startedAt: state.startedAt,
          deadlineAt: state.deadlineAt,
          extensionCount: state.extensionCount,
          status: "abandoned",
          aggregateVersion: state.aggregateVersion + 1,
          resolvedAt: state.responseDeadlineAt,
          updatedAt: state.responseDeadlineAt,
        });
      }
      return state;
    },
    eraseRescueForAccountDeletion: async () => {
      eraseCalls += 1;
      state = null;
      return { erased: true as const };
    },
  };
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue: "main",
    workflowsPath,
    activities,
  });
  return {
    environment,
    worker,
    advanceCalls,
    eraseCalls: () => eraseCalls,
    setState(next: RescueIntervention | null) {
      state = next;
    },
  };
}

describe("UrgeRescueWorkflow time skipping", () => {
  it("survives the ten-minute cooldown, opens five-minute check-in, then abandons once", async () => {
    const startedAt = Date.now();
    const fixture = await testWorker(active(startedAt));

    const result = await fixture.worker.runUntil(() =>
      fixture.environment.client.workflow.execute(UrgeRescueWorkflow, {
        workflowId: `rescue/${interventionId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, interventionId }],
      }),
    );

    expect(result).toEqual({ interventionId, status: "abandoned" });
    expect(fixture.advanceCalls).toEqual([1, 2]);
  });

  it("reloads authoritative safe state after duplicate signals instead of creating effects", async () => {
    const startedAt = Date.now();
    const fixture = await testWorker(active(startedAt));

    await fixture.worker.runUntil(async () => {
      const handle = await fixture.environment.client.workflow.start(UrgeRescueWorkflow, {
        workflowId: `rescue/${interventionId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, interventionId }],
      });
      await fixture.environment.sleep("1 second");
      fixture.setState(
        RescueInterventionSchema.parse({
          ...active(startedAt),
          status: "safe",
          aggregateVersion: 2,
          resolvedAt: startedAt + 1_000,
          updatedAt: startedAt + 1_000,
        }),
      );
      const signal = { schemaVersion: 1 as const, interventionId, expectedAggregateVersion: 2 };
      await handle.signal(safeRescueSignal, signal);
      await handle.signal(safeRescueSignal, signal);
      expect(await handle.query(rescueStateQuery)).toBe("active");
      await expect(handle.result()).resolves.toEqual({ interventionId, status: "safe" });
    });
    expect(fixture.advanceCalls).toEqual([]);
  });

  it("wakes on an extension and waits from the authoritative prior-deadline state", async () => {
    const startedAt = Date.now();
    const fixture = await testWorker(active(startedAt));

    const result = await fixture.worker.runUntil(async () => {
      const handle = await fixture.environment.client.workflow.start(UrgeRescueWorkflow, {
        workflowId: `rescue/${interventionId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, interventionId }],
      });
      await fixture.environment.sleep("1 second");
      fixture.setState(active(startedAt, 1, 2));
      await handle.signal(extendRescueSignal, {
        schemaVersion: 1,
        interventionId,
        expectedAggregateVersion: 2,
      });
      return handle.result();
    });

    expect(result).toEqual({ interventionId, status: "abandoned" });
    expect(fixture.advanceCalls).toEqual([2, 3]);
  });

  it("terminates slipped from authoritative state without creating a workflow side effect", async () => {
    const startedAt = Date.now();
    const fixture = await testWorker(active(startedAt));

    const result = await fixture.worker.runUntil(async () => {
      const handle = await fixture.environment.client.workflow.start(UrgeRescueWorkflow, {
        workflowId: `rescue/${interventionId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, interventionId }],
      });
      await fixture.environment.sleep("1 second");
      fixture.setState(
        RescueInterventionSchema.parse({
          ...active(startedAt),
          status: "slipped",
          aggregateVersion: 2,
          resolvedAt: startedAt + 1_000,
          updatedAt: startedAt + 1_000,
        }),
      );
      await handle.signal(slippedRescueSignal, {
        schemaVersion: 1,
        interventionId,
        expectedAggregateVersion: 2,
      });
      return handle.result();
    });

    expect(result).toEqual({ interventionId, status: "slipped" });
    expect(fixture.advanceCalls).toEqual([]);
  });

  it("abandons immediately at the two-extension absolute limit", async () => {
    const startedAt = Date.now();
    const fixture = await testWorker(active(startedAt));

    const result = await fixture.worker.runUntil(async () => {
      const handle = await fixture.environment.client.workflow.start(UrgeRescueWorkflow, {
        workflowId: `rescue/${interventionId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, interventionId }],
      });
      await fixture.environment.sleep("1 second");
      fixture.setState(active(startedAt, 2, 3));
      await handle.signal(extendRescueSignal, {
        schemaVersion: 1,
        interventionId,
        expectedAggregateVersion: 3,
      });
      return handle.result();
    });

    expect(result).toEqual({ interventionId, status: "abandoned" });
    expect(fixture.advanceCalls).toEqual([3]);
  });

  it("erases private state and terminates when account deletion wins the timer race", async () => {
    const startedAt = Date.now();
    const fixture = await testWorker(active(startedAt));

    const result = await fixture.worker.runUntil(async () => {
      const handle = await fixture.environment.client.workflow.start(UrgeRescueWorkflow, {
        workflowId: `rescue/${interventionId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, interventionId }],
      });
      await handle.signal(rescueAccountDeletedSignal, {
        schemaVersion: 1,
        interventionId,
        expectedAggregateVersion: 1,
      });
      return handle.result();
    });

    expect(result).toEqual({ interventionId, status: "account_deleted" });
    expect(fixture.eraseCalls()).toBe(1);
    expect(fixture.advanceCalls).toEqual([]);
  });

  it("replays completed durable timers for a replacement worker", async () => {
    const startedAt = Date.now();
    const fixture = await testWorker(active(startedAt));
    let history: unknown;

    await fixture.worker.runUntil(async () => {
      const handle = await fixture.environment.client.workflow.start(UrgeRescueWorkflow, {
        workflowId: `rescue/${interventionId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, interventionId }],
      });
      await expect(handle.result()).resolves.toEqual({ interventionId, status: "abandoned" });
      history = await handle.fetchHistory();
    });

    expect(history).toBeDefined();
    await Worker.runReplayHistory({ workflowsPath }, history, `rescue/${interventionId}`);
    expect(fixture.advanceCalls).toEqual([1, 2]);
  });

  it("resumes an open intervention on a replacement polling worker", async () => {
    const environment = await TestWorkflowEnvironment.createLocal();
    environments.push(environment);
    const startedAt = Date.now();
    let state: RescueIntervention | null = active(startedAt);
    const workerOptions = {
      connection: environment.nativeConnection,
      taskQueue: "main",
      workflowsPath,
      activities: {
        loadRescue: async () => state,
        advanceRescueAtDeadline: async () => state,
        eraseRescueForAccountDeletion: async () => ({ erased: true as const }),
      },
    };
    const firstWorker = await Worker.create(workerOptions);
    let handle: Awaited<ReturnType<typeof environment.client.workflow.start>> | undefined;

    await firstWorker.runUntil(async () => {
      handle = await environment.client.workflow.start(UrgeRescueWorkflow, {
        workflowId: `rescue-restart/${interventionId}`,
        taskQueue: "main",
        args: [{ schemaVersion: 1, interventionId }],
      });
      let stateQuery = await handle.query(rescueStateQuery);
      while (stateQuery === "loading") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        stateQuery = await handle.query(rescueStateQuery);
      }
      expect(stateQuery).toBe("active");
    });
    if (!handle) throw new Error("workflow handle missing");
    const activeHandle = handle;

    state = RescueInterventionSchema.parse({
      ...active(startedAt),
      status: "safe",
      aggregateVersion: 2,
      resolvedAt: startedAt + 1_000,
      updatedAt: startedAt + 1_000,
    });
    await activeHandle.signal(safeRescueSignal, {
      schemaVersion: 1,
      interventionId,
      expectedAggregateVersion: 2,
    });

    const replacementWorker = await Worker.create(workerOptions);
    await expect(replacementWorker.runUntil(() => activeHandle.result())).resolves.toEqual({
      interventionId,
      status: "safe",
    });
  }, 60_000);
});
