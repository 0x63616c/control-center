import { proxyActivities, sleep } from "@temporalio/workflow";
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
  Pick<typeof activities, "prepareNotification" | "deliverNotification">
>({
  startToCloseTimeout: "20 seconds",
  retry: {
    initialInterval: "15 seconds",
    backoffCoefficient: 2,
    maximumInterval: "15 minutes",
    maximumAttempts: 8,
  },
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
  readonly outcomes: readonly string[];
}

export async function NotificationDeliveryWorkflow(
  input: NotificationDeliveryWorkflowInput,
): Promise<NotificationDeliveryWorkflowOutput> {
  const parsed = NotificationDeliveryWorkflowInputSchema.parse(input);
  const prepared = await notificationActivities.prepareNotification({
    notificationId: parsed.notificationId,
  });
  const outcomes: string[] = [];
  for (const deliveryId of prepared.deliveryIds) {
    const outcome = await notificationActivities.deliverNotification({ deliveryId });
    outcomes.push(outcome.kind);
  }
  return {
    notificationId: parsed.notificationId,
    deliveryCount: prepared.deliveryIds.length,
    outcomes,
  };
}
