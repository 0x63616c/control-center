import type { WorkflowStartOptions } from "@temporalio/client";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import type { DomainEvent } from "./domain-events";
import type { PostCommitEventNudge } from "./domain-transaction";

export const DTYE_TEMPORAL_NAMESPACE = "dont-text-your-ex" as const;
export const DTYE_TEMPORAL_TASK_QUEUE = "main" as const;

export type RecoveryWorkflowStart = Readonly<{
  workflowType: "OutboxDispatchRecoveryWorkflow";
  workflowId: string;
  taskQueue: typeof DTYE_TEMPORAL_TASK_QUEUE;
  args: Readonly<{ schemaVersion: 1; eventIds: readonly DomainEvent["id"][] }>;
}>;

export interface RecoveryWorkflowStarter {
  start(input: RecoveryWorkflowStart): Promise<void>;
}

export class RecordingRecoveryWorkflowStarter implements RecoveryWorkflowStarter {
  readonly #starts: RecoveryWorkflowStart[] = [];
  async start(input: RecoveryWorkflowStart): Promise<void> {
    this.#starts.push(input);
  }
  calls(): readonly RecoveryWorkflowStart[] {
    return this.#starts.map((start) => ({ ...start, args: { ...start.args } }));
  }
}

export class TemporalPostCommitNudge implements PostCommitEventNudge {
  constructor(private readonly starter: RecoveryWorkflowStarter) {}

  async nudge(eventIds: readonly DomainEvent["id"][]): Promise<void> {
    await Promise.all(
      eventIds.map((eventId) =>
        this.starter.start({
          workflowType: "OutboxDispatchRecoveryWorkflow",
          workflowId: `outbox/${eventId}`,
          taskQueue: DTYE_TEMPORAL_TASK_QUEUE,
          args: { schemaVersion: 1, eventIds: [eventId] },
        }),
      ),
    );
  }
}

export function temporalRecoveryWorkflowStarter(address: string): RecoveryWorkflowStarter {
  const connection = Connection.lazy({ address });
  const client = new Client({ connection, namespace: DTYE_TEMPORAL_NAMESPACE });
  return {
    async start(input) {
      const options: WorkflowStartOptions = {
        workflowId: input.workflowId,
        taskQueue: input.taskQueue,
        args: [input.args],
      };
      try {
        await client.workflow.start(input.workflowType, options);
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    },
  };
}
