import type { ApnsClient, NotificationStore } from "@dont-text-your-ex/notifications";
import { describe, expect, it, vi } from "vitest";
import { NotificationDeliveryIdSchema, NotificationIdSchema } from "../../../contracts";
import { createNotificationActivities } from "./notification-activities";

const notificationId = NotificationIdSchema.parse("ntf_example");
const deliveryId = NotificationDeliveryIdSchema.parse("ndl_example");

function store(overrides: Partial<NotificationStore> = {}): NotificationStore {
  return {
    registerDevice: vi.fn(),
    disableDevice: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    resolveTarget: vi.fn(),
    prepareDeliveries: vi.fn(async () => [deliveryId]),
    loadDelivery: vi.fn(async () => ({
      deliveryId,
      notificationId,
      deviceToken: "ab".repeat(32),
      environment: "sandbox",
    })),
    recordDeliveryOutcome: vi.fn(),
    ...overrides,
  } as NotificationStore;
}

describe("notification delivery activities", () => {
  it("returns stable delivery ids without exposing device tokens", async () => {
    const activities = createNotificationActivities({
      store: store(),
      apnsClient: () => ({ send: vi.fn() }) as ApnsClient,
    });

    await expect(activities.prepareNotification({ notificationId })).resolves.toEqual({
      deliveryIds: [deliveryId],
    });
  });

  it("throws a retryable error instead of persisting a transient APNs result", async () => {
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
    });

    await expect(activities.deliverNotification({ deliveryId })).rejects.toThrow(
      "retryable APNs failure: Shutdown",
    );
    expect(recordDeliveryOutcome).not.toHaveBeenCalled();
  });

  it("persists a terminal device rejection", async () => {
    const recordDeliveryOutcome = vi.fn();
    const activities = createNotificationActivities({
      store: store({ recordDeliveryOutcome }),
      apnsClient: () => ({
        send: vi.fn(async () => ({ kind: "invalid_device" as const, reason: "Unregistered" })),
      }),
    });

    await expect(activities.deliverNotification({ deliveryId })).resolves.toEqual({
      kind: "invalid_device",
      reason: "Unregistered",
    });
    expect(recordDeliveryOutcome).toHaveBeenCalledWith(deliveryId, {
      kind: "invalid_device",
      reason: "Unregistered",
    });
  });
});
