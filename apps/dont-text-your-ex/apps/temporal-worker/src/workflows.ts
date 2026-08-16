import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import {
  type NotificationDeliveryWorkflowInput,
  NotificationDeliveryWorkflowInputSchema,
} from "../../../contracts";
import type * as activities from "./activities";
import { HEALTH_CHECK_PERIOD_MS, healthCheckSleepMs } from "./pacing";

export interface DtyeHealthCheckWorkflowInput {
  readonly iterations: number;
  readonly periodMs?: number;
}
export interface DtyeHealthCheckWorkflowOutput {
  readonly status: "healthy";
  readonly checks: number;
}

const { DtyeHealthCheckActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 seconds",
  retry: { maximumAttempts: 2 },
});

const notificationActivities = proxyActivities<
  Pick<typeof activities, "prepareNotification" | "deliverNotification" | "suppressNotification">
>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 2 },
});

export async function DtyeHealthCheckWorkflow(
  input: DtyeHealthCheckWorkflowInput,
): Promise<DtyeHealthCheckWorkflowOutput> {
  const periodMs = input.periodMs ?? HEALTH_CHECK_PERIOD_MS;
  const startedAtMs = Date.now();
  for (let iteration = 0; iteration < input.iterations; iteration += 1) {
    const waitMs = healthCheckSleepMs(
      iteration,
      Date.now() - startedAtMs,
      input.iterations,
      periodMs,
    );
    if (waitMs > 0) await sleep(waitMs);
    await DtyeHealthCheckActivity({ iteration });
  }
  return { status: "healthy", checks: input.iterations };
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
