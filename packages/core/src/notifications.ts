import { enqueueJob, type JobQueueDb, type JsonObject, type JsonValue } from "./jobs/queue";

/**
 * Feature-neutral intent to surface a notification. Producers publish this
 * contract; the notif App owns persistence and delivery.
 */
export interface NotificationIntent extends JsonObject {
  category: "ci" | "system" | "home" | "media";
  severity: "info" | "warning" | "critical";
  title: string;
  body?: string | null;
  deepLink?: string | null;
  data?: JsonValue;
  /** Stable producer identity required because the durable queue is at-least-once. */
  dedupeKey: string;
}

/** Publish without importing the notif App from another feature. */
export function enqueueNotification(db: JobQueueDb, input: NotificationIntent): Promise<number> {
  return enqueueJob(db, "raise_notification", input);
}
