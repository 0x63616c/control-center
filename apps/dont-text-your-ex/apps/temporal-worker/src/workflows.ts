import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import {
  type NotificationDeliveryWorkflowInput,
  NotificationDeliveryWorkflowInputSchema,
  type RescueIntervention,
  type RescueInterventionWorkflowInput,
  RescueInterventionWorkflowInputSchema,
  type RescueSignalInput,
  RescueSignalInputSchema,
} from "../../../contracts";
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

const notificationActivities = proxyActivities<
  Pick<DtyeActivities, "prepareNotification" | "deliverNotification" | "suppressNotification">
>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 2 },
});

const rescueActivities = proxyActivities<
  Pick<DtyeActivities, "loadRescue" | "advanceRescueAtDeadline" | "eraseRescueForAccountDeletion">
>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "30 seconds",
    maximumAttempts: 10,
  },
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

export interface NotificationDeliveryWorkflowOutput {
  readonly notificationId: string;
  readonly deliveryCount: number;
  readonly outcomes: readonly NotificationDeliveryTerminalState[];
}

export type NotificationDeliveryTerminalState = "delivered" | "suppressed" | "permanent_failure";
export const accountDeletedSignal =
  defineSignal<
    [
      {
        readonly schemaVersion: 1;
        readonly aggregateId: string;
        readonly expectedAggregateVersion: number;
      },
    ]
  >("accountDeleted");
export const deliveryStateQuery = defineQuery<NotificationDeliveryTerminalState | "delivering">(
  "deliveryState",
);

export async function NotificationDeliveryWorkflow(
  input: NotificationDeliveryWorkflowInput,
): Promise<NotificationDeliveryWorkflowOutput> {
  const parsed = NotificationDeliveryWorkflowInputSchema.parse(input);
  let accountDeleted = false;
  let workflowState: NotificationDeliveryTerminalState | "delivering" = "delivering";
  setHandler(accountDeletedSignal, () => {
    accountDeleted = true;
  });
  setHandler(deliveryStateQuery, () => workflowState);
  const prepared = await notificationActivities.prepareNotification({
    notificationId: parsed.notificationId,
  });
  const outcomes = await Promise.all(
    prepared.deliveryIds.map(async (deliveryId): Promise<NotificationDeliveryTerminalState> => {
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        if (accountDeleted) return "suppressed";
        const outcome = await notificationActivities.deliverNotification({
          deliveryId,
          finalAttempt: attempt === 8,
        });
        if (outcome.kind === "accepted") return "delivered";
        if (outcome.kind === "already_terminal") return "suppressed";
        if (outcome.kind !== "retry") return "permanent_failure";
        await condition(
          () => accountDeleted,
          Math.max(outcome.retryAfterMs, Math.min(15_000 * 2 ** (attempt - 1), 900_000)),
        );
      }
      return "permanent_failure";
    }),
  );
  if (accountDeleted) {
    await notificationActivities.suppressNotification({ notificationId: parsed.notificationId });
  }
  workflowState = outcomes.includes("delivered")
    ? "delivered"
    : outcomes.includes("permanent_failure")
      ? "permanent_failure"
      : "suppressed";
  return {
    notificationId: parsed.notificationId,
    deliveryCount: prepared.deliveryIds.length,
    outcomes,
  };
}

export type RescueWorkflowState = RescueIntervention["status"] | "account_deleted" | "loading";
export interface UrgeRescueWorkflowOutput {
  readonly interventionId: RescueInterventionWorkflowInput["interventionId"];
  readonly status: Exclude<RescueWorkflowState, "loading">;
}

export const safeRescueSignal = defineSignal<[RescueSignalInput]>("safe");
export const slippedRescueSignal = defineSignal<[RescueSignalInput]>("slipped");
export const extendRescueSignal = defineSignal<[RescueSignalInput]>("extend");
export const rescueAccountDeletedSignal = defineSignal<[RescueSignalInput]>("accountDeleted");
export const rescueStateQuery = defineQuery<RescueWorkflowState>("rescueState");

export async function UrgeRescueWorkflow(
  input: RescueInterventionWorkflowInput,
): Promise<UrgeRescueWorkflowOutput> {
  const parsed = RescueInterventionWorkflowInputSchema.parse(input);
  let workflowState: RescueWorkflowState = "loading";
  let wakeRevision = 0;
  let accountDeleted = false;

  const wakeForMatchingIntervention = (signalInput: RescueSignalInput) => {
    const signal = RescueSignalInputSchema.parse(signalInput);
    if (signal.interventionId === parsed.interventionId) wakeRevision += 1;
  };
  setHandler(safeRescueSignal, wakeForMatchingIntervention);
  setHandler(slippedRescueSignal, wakeForMatchingIntervention);
  setHandler(extendRescueSignal, wakeForMatchingIntervention);
  setHandler(rescueAccountDeletedSignal, (signalInput) => {
    const signal = RescueSignalInputSchema.parse(signalInput);
    if (signal.interventionId !== parsed.interventionId) return;
    accountDeleted = true;
    wakeRevision += 1;
  });
  setHandler(rescueStateQuery, () => workflowState);

  while (true) {
    if (accountDeleted) {
      await rescueActivities.eraseRescueForAccountDeletion({
        interventionId: parsed.interventionId,
      });
      workflowState = "account_deleted";
      return { interventionId: parsed.interventionId, status: workflowState };
    }

    const intervention = await rescueActivities.loadRescue({
      interventionId: parsed.interventionId,
    });
    if (!intervention) {
      workflowState = "account_deleted";
      return { interventionId: parsed.interventionId, status: workflowState };
    }
    workflowState = intervention.status;
    if (
      intervention.status === "safe" ||
      intervention.status === "slipped" ||
      intervention.status === "abandoned"
    ) {
      return { interventionId: parsed.interventionId, status: intervention.status };
    }

    const observedWakeRevision = wakeRevision;
    const deadlineAt =
      intervention.status === "active" ? intervention.deadlineAt : intervention.responseDeadlineAt;
    const woke = await condition(
      () => accountDeleted || wakeRevision !== observedWakeRevision,
      Math.max(0, deadlineAt - Date.now()),
    );
    if (woke) continue;

    const advanced = await rescueActivities.advanceRescueAtDeadline({
      interventionId: parsed.interventionId,
      expectedAggregateVersion: intervention.aggregateVersion,
    });
    if (advanced) workflowState = advanced.status;
  }
}
