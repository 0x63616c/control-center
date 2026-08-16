import { continueAsNew, proxyActivities, sleep } from "@temporalio/workflow";
import type { DomainEvent } from "../../api/src/domain-events";
import type { DtyeActivities } from "./activities";
import { HEALTH_CHECK_PERIOD_MS, healthCheckSleepMs } from "./pacing";
import { nextPagingDecision } from "./workflow-paging";

export interface DtyeHealthCheckWorkflowInput {
  readonly schemaVersion: 1;
}
export interface DtyeHealthCheckWorkflowOutput {
  readonly status: "healthy";
  readonly checks: number;
}

const { DtyeHealthCheckActivity } = proxyActivities<
  Pick<DtyeActivities, "DtyeHealthCheckActivity">
>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 2 },
});

export async function DtyeHealthCheckWorkflow(
  input: DtyeHealthCheckWorkflowInput,
): Promise<DtyeHealthCheckWorkflowOutput> {
  if (input.schemaVersion !== 1) throw new Error("unsupported health workflow schema");
  const iterations = 5;
  const startedAtMs = Date.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const waitMs = healthCheckSleepMs(
      iteration,
      Date.now() - startedAtMs,
      iterations,
      HEALTH_CHECK_PERIOD_MS,
    );
    if (waitMs > 0) await sleep(waitMs);
    await DtyeHealthCheckActivity({ iteration });
  }
  return { status: "healthy", checks: iterations };
}

const { OutboxDispatchActivity } = proxyActivities<Pick<DtyeActivities, "OutboxDispatchActivity">>({
  startToCloseTimeout: "25 seconds",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 10,
  },
});

const { SessionMaintenanceActivity } = proxyActivities<
  Pick<DtyeActivities, "SessionMaintenanceActivity">
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 10,
  },
});

export interface OutboxDispatchRecoveryWorkflowInput {
  readonly schemaVersion: 1;
  readonly eventIds?: readonly DomainEvent["id"][];
  readonly totals?: Readonly<{ accepted: number; retried: number; failed: number }>;
  readonly runs?: number;
}

export async function OutboxDispatchRecoveryWorkflow(
  input: OutboxDispatchRecoveryWorkflowInput,
): Promise<{ accepted: number; retried: number; failed: number; runs: number }> {
  if (input.schemaVersion !== 1) throw new Error("unsupported outbox recovery workflow schema");
  let pageCount = 0;
  let totals = input.totals ?? { accepted: 0, retried: 0, failed: 0 };
  while (true) {
    const page = await OutboxDispatchActivity({ eventIds: input.eventIds, limit: 1 });
    pageCount += 1;
    totals = {
      accepted: totals.accepted + page.accepted,
      retried: totals.retried + page.retried,
      failed: totals.failed + page.failed,
    };
    const decision = nextPagingDecision({ pageSize: 1, pageCount, processed: page.claimed });
    if (decision === "complete") return { ...totals, runs: (input.runs ?? 0) + 1 };
    if (decision === "continue_as_new") {
      return continueAsNew<typeof OutboxDispatchRecoveryWorkflow>({
        ...input,
        totals,
        runs: (input.runs ?? 0) + 1,
      });
    }
  }
}

export interface SessionMaintenanceWorkflowInput {
  readonly schemaVersion: 1;
  readonly deleted?: number;
  readonly runs?: number;
  /** Stable cutoff carried through continue-as-new so a run cannot chase new expirations. */
  readonly purgeBefore?: number;
}

export async function SessionMaintenanceWorkflow(
  input: SessionMaintenanceWorkflowInput,
): Promise<{ deleted: number; runs: number }> {
  if (input.schemaVersion !== 1) {
    throw new Error("unsupported session maintenance workflow schema");
  }
  let pageCount = 0;
  let deleted = input.deleted ?? 0;
  const purgeBefore = input.purgeBefore ?? Date.now();
  while (true) {
    const page = await SessionMaintenanceActivity({ now: purgeBefore, limit: 500 });
    pageCount += 1;
    deleted += page.deleted;
    const decision = nextPagingDecision({ pageSize: 500, pageCount, processed: page.deleted });
    if (decision === "complete") return { deleted, runs: (input.runs ?? 0) + 1 };
    if (decision === "continue_as_new") {
      return continueAsNew<typeof SessionMaintenanceWorkflow>({
        schemaVersion: 1,
        deleted,
        runs: (input.runs ?? 0) + 1,
        purgeBefore,
      });
    }
  }
}
