import type { ApnsClient, NotificationStore } from "@dont-text-your-ex/notifications";
import { describe, expect, it, vi } from "vitest";
import { NotificationDeliveryIdSchema, NotificationIdSchema } from "../../../contracts";
import { createNotificationActivities } from "./notification-activities";

const notificationId = NotificationIdSchema.parse("ntf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const deliveryId = NotificationDeliveryIdSchema.parse("ndl_example");
const logger = { info: vi.fn(), warn: vi.fn() };

function store(overrides: Partial<NotificationStore> = {}): NotificationStore {
  return {
    registerDevice: vi.fn(),
    disableDevice: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    resolveTarget: vi.fn(),
    prepareDeliveries: vi.fn(async () => [deliveryId]),
    suppressPending: vi.fn(),
    rotateTokenBatch: vi.fn(async () => 0),
    loadDelivery: vi.fn(async () => ({
      kind: "ready" as const,
      delivery: {
        deliveryId,
        notificationId,
        deviceToken: "ab".repeat(32),
        environment: "sandbox" as const,
        expiresAtMs: null,
      },
    })),
    recordDeliveryOutcome: vi.fn(),
    withDeliveryAccountFence: vi.fn(async (_deliveryId, effect) => effect()),
    ...overrides,
  } as NotificationStore;
}

describe("notification delivery activities", () => {
  it("returns stable delivery ids without exposing device tokens", async () => {
    const activities = createNotificationActivities({
      store: store(),
      apnsClient: () => ({ send: vi.fn() }) as ApnsClient,
      logger,
    });

    await expect(activities.prepareNotification({ notificationId })).resolves.toEqual({
      deliveryIds: [deliveryId],
    });
  });

  it("persists a finite retry result for durable workflow backoff", async () => {
    const recordDeliveryOutcome = vi.fn();
    const activities = createNotificationActivities({
      store: store({ recordDeliveryOutcome }),
      apnsClient: () => ({
        send: vi.fn(async () => ({
          kind: "retry" as const,
          reason: "Shutdown",
          retryAfterMs: 15_000,
        })),
      }),
      logger,
    });

    await expect(
      activities.deliverNotification({ deliveryId, finalAttempt: false }),
    ).resolves.toEqual({ kind: "retry", reason: "Shutdown", retryAfterMs: 15_000 });
    expect(recordDeliveryOutcome).toHaveBeenCalledWith(deliveryId, {
      kind: "retry",
      reason: "Shutdown",
      retryAfterMs: 15_000,
    });
  });

  it("persists a terminal device rejection", async () => {
    const recordDeliveryOutcome = vi.fn();
    const activities = createNotificationActivities({
      store: store({ recordDeliveryOutcome }),
      apnsClient: () => ({
        send: vi.fn(async () => ({ kind: "invalid_device" as const, reason: "Unregistered" })),
      }),
      logger,
    });

    await expect(
      activities.deliverNotification({ deliveryId, finalAttempt: false }),
    ).resolves.toEqual({
      kind: "invalid_device",
      reason: "Unregistered",
    });
    expect(recordDeliveryOutcome).toHaveBeenCalledWith(deliveryId, {
      kind: "invalid_device",
      reason: "Unregistered",
    });
  });

  it("replays the persisted terminal outcome without sending to APNs again", async () => {
    const send = vi.fn();
    const activities = createNotificationActivities({
      store: store({
        loadDelivery: vi.fn(async () => ({
          kind: "terminal" as const,
          state: "delivered" as const,
        })),
      }),
      apnsClient: () => ({ send }) as ApnsClient,
      logger,
    });

    await expect(
      activities.deliverNotification({ deliveryId, finalAttempt: false }),
    ).resolves.toEqual({ kind: "already_terminal", state: "delivered" });
    expect(send).not.toHaveBeenCalled();
  });
});
