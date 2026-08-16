import { describe, expect, it } from "vitest";
import { RecordingRecoveryWorkflowStarter, TemporalPostCommitNudge } from "../temporal-nudge";

describe("Temporal post-commit nudge", () => {
  it("starts one idempotent recovery execution per opaque event on task queue main", async () => {
    const starter = new RecordingRecoveryWorkflowStarter();
    const nudge = new TemporalPostCommitNudge(starter);

    await nudge.nudge(["evt_one", "evt_two"] as never);

    expect(starter.calls()).toEqual([
      {
        workflowType: "OutboxDispatchRecoveryWorkflow",
        workflowId: "outbox/evt_one",
        taskQueue: "main",
        args: { schemaVersion: 1, eventIds: ["evt_one"] },
      },
      {
        workflowType: "OutboxDispatchRecoveryWorkflow",
        workflowId: "outbox/evt_two",
        taskQueue: "main",
        args: { schemaVersion: 1, eventIds: ["evt_two"] },
      },
    ]);
  });
});
