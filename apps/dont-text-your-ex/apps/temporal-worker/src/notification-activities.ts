import type {
  ApnsClient,
  NotificationStore,
  PersistedDeliveryOutcome,
} from "@dont-text-your-ex/notifications";
import type { NotificationDeliveryId, NotificationId } from "../../../contracts";

export interface NotificationActivities {
  prepareNotification(input: {
    readonly notificationId: NotificationId;
  }): Promise<{ readonly deliveryIds: readonly NotificationDeliveryId[] }>;
  deliverNotification(input: {
    readonly deliveryId: NotificationDeliveryId;
  }): Promise<PersistedDeliveryOutcome | { readonly kind: "already_terminal" }>;
}

export function createNotificationActivities(deps: {
  readonly store: NotificationStore;
  readonly apnsClient: (environment: "production" | "sandbox") => ApnsClient;
}): NotificationActivities {
  return {
    async prepareNotification({ notificationId }) {
      return { deliveryIds: await deps.store.prepareDeliveries(notificationId) };
    },
    async deliverNotification({ deliveryId }) {
      const delivery = await deps.store.loadDelivery(deliveryId);
      if (!delivery) return { kind: "already_terminal" };
      const outcome = await deps.apnsClient(delivery.environment).send({
        deviceToken: delivery.deviceToken,
        notificationId: delivery.notificationId,
      });
      if (outcome.kind === "retry") {
        throw new Error(`retryable APNs failure: ${outcome.reason}`);
      }
      await deps.store.recordDeliveryOutcome(deliveryId, outcome);
      return outcome;
    },
  };
}
