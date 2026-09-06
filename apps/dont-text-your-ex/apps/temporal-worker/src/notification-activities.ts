import type {
  ApnsClient,
  ApnsOutcome,
  NotificationStore,
  PersistedDeliveryOutcome,
} from "@dont-text-your-ex/notifications";
import type { NotificationDeliveryId, NotificationId } from "../../../contracts";

export interface NotificationActivities {
  prepareNotification(input: {
    readonly notificationId: NotificationId;
  }): Promise<{ readonly deliveryIds: readonly NotificationDeliveryId[] }>;
  suppressNotification(input: { readonly notificationId: NotificationId }): Promise<void>;
  rotatePushTokenBatch(input: {
    readonly batchSize: number;
  }): Promise<{ readonly rotated: number }>;
  deliverNotification(input: {
    readonly deliveryId: NotificationDeliveryId;
    readonly finalAttempt: boolean;
  }): Promise<
    | ApnsOutcome
    | {
        readonly kind: "already_terminal";
        readonly state: "delivered" | "suppressed" | "permanent_failure";
      }
  >;
}

interface NotificationActivityLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export function createNotificationActivities(deps: {
  readonly store: NotificationStore;
  readonly apnsClient: (environment: "production" | "sandbox") => ApnsClient;
  readonly logger: NotificationActivityLogger;
}): NotificationActivities {
  return {
    async prepareNotification({ notificationId }) {
      const deliveryIds = await deps.store.prepareDeliveries(notificationId);
      deps.logger.info(
        { notificationId, deliveryCount: deliveryIds.length },
        "notification deliveries prepared",
      );
      return { deliveryIds };
    },
    async suppressNotification({ notificationId }) {
      await deps.store.suppressPending(notificationId);
      deps.logger.info({ notificationId }, "pending notification deliveries suppressed");
    },
    async rotatePushTokenBatch({ batchSize }) {
      const rotated = await deps.store.rotateTokenBatch(batchSize);
      deps.logger.info({ rotated }, "push token encryption batch rotated");
      return { rotated };
    },
    async deliverNotification({ deliveryId, finalAttempt }) {
      const result = await deps.store.withDeliveryAccountFence(deliveryId, async () => {
        const delivery = await deps.store.loadDelivery(deliveryId);
        if (!delivery) return { kind: "already_terminal" as const, state: "suppressed" as const };
        if (delivery.kind === "terminal") {
          return { kind: "already_terminal" as const, state: delivery.state };
        }
        const outcome = await deps.apnsClient(delivery.delivery.environment).send({
          deviceToken: delivery.delivery.deviceToken,
          notificationId: delivery.delivery.notificationId,
          expiresAtMs: delivery.delivery.expiresAtMs,
        });
        if (outcome.kind === "retry") {
          const persistedOutcome: PersistedDeliveryOutcome = finalAttempt
            ? { kind: "permanent_notification", reason: "retry_exhausted" }
            : outcome;
          await deps.store.recordDeliveryOutcome(deliveryId, persistedOutcome);
          deps.logger.warn(
            {
              deliveryId,
              notificationId: delivery.delivery.notificationId,
              outcome: persistedOutcome.kind,
            },
            finalAttempt
              ? "notification delivery retries exhausted"
              : "notification delivery deferred",
          );
          return finalAttempt ? persistedOutcome : outcome;
        }
        await deps.store.recordDeliveryOutcome(deliveryId, outcome);
        deps.logger.info(
          { deliveryId, notificationId: delivery.delivery.notificationId, outcome: outcome.kind },
          "notification delivery completed",
        );
        return outcome;
      });
      return result ?? { kind: "already_terminal", state: "suppressed" };
    },
  };
}
