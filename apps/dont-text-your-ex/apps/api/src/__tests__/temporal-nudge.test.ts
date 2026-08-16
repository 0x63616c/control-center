import { describe, expect, it } from "vitest";
import { RecordingRecoveryWorkflowStarter, TemporalPostCommitNudge } from "../temporal-nudge";

describe("Temporal post-commit nudge", () => {
  it("starts one idempotent recovery execution per opaque event on task queue main", async () => {
    const starter = new RecordingRecoveryWorkflowStarter();
    const nudge = new TemporalPostCommitNudge(starter);

    await nudge.nudge([
      "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ] as never);

    expect(starter.calls()).toEqual([
      {
        workflowType: "OutboxDispatchRecoveryWorkflow",
        workflowId: "outbox/evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        taskQueue: "main",
        args: { schemaVersion: 1, eventIds: ["evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] },
      },
      {
        workflowType: "OutboxDispatchRecoveryWorkflow",
        workflowId: "outbox/evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        taskQueue: "main",
        args: { schemaVersion: 1, eventIds: ["evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] },
      },
    ]);
  });

  it("admits only one unresolved batch so a Temporal outage cannot accumulate RPCs", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const starts: string[] = [];
    const nudge = new TemporalPostCommitNudge({
      async start(input) {
        starts.push(input.workflowId);
        await blocked;
      },
    });

    const first = nudge.nudge(["evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"] as never);
    await Promise.resolve();
    await nudge.nudge(["evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] as never);

    expect(starts).toEqual(["outbox/evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    release?.();
    await first;
    await nudge.nudge(["evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] as never);
    expect(starts).toEqual([
      "outbox/evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "outbox/evt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });
});
