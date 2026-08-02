/**
 * Notification Center domain service (Track C, S1 fold). Every notification in
 * the system is raised through raiseNotification, which does two things
 * atomically enough for our purposes: writes the feed row, then enqueues a
 * `notify` job (@www/core's durable queue) that fans the alert out to
 * registered devices over APNs. Producers never talk to APNs directly , they
 * raise, and the queue owns delivery + retry.
 *
 * DEDUPE: a producer re-raising the same logical condition (a flapping
 * integration, a deploy that fails on every push) passes a stable `dedupeKey`.
 * The unique index on dedupe_key turns the repeat into an UPDATE of the existing
 * row, so the feed shows one entry that moves to the top rather than fifty
 * identical ones. A re-raise deliberately CLEARS readAt: the condition has
 * recurred, so it is unread news again, not a row the user has already dealt
 * with. Omitting the key means "this is a distinct event" , and
 * because Postgres treats NULLs as distinct in a unique index, unkeyed rows
 * never collide.
 *
 * Follows the explicit-`db` style of frontend-log-service (the db is a
 * parameter, not a module singleton) so callers control the connection and
 * tests can hand in a mock. The one exception is the job handler at the bottom,
 * which is a process entrypoint and therefore owns its own db reference (the
 * feature's own singleton, ./db), the same way a queue handler
 * does.
 */
import { randomBytes } from "node:crypto";
import { enqueueJob, type JobHandler } from "@www/core";
import { getLogger } from "@www/logger";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { type ApnsAlert, sendApnsPush } from "./apns";
import { db as singletonDb } from "./db";
import * as schema from "./schema";

/** Job type string for the APNs fan-out job. */
const NOTIFY_JOB_TYPE = "notify";

/**
 * Registered here (not only in ./jobs.ts) because this file, not jobs.ts, is
 * the producer every consuming tsc program actually reaches: apps/api pulls it
 * in transitively via router.gen -> api.ts -> service.ts, apps/worker via
 * jobs.gen -> jobs.ts -> service.ts, and the features/** program includes it
 * directly as a glob root. jobs.ts augments the SAME interface member (see its
 * own declaration below) purely for local readability at the facet's
 * definition site; TS interface merging is idempotent across identical
 * declarations in one program.
 */
declare module "@www/core" {
  interface JobTypeRegistry {
    notify: { notificationId: string };
  }
}

/** Default page size for the feed; the panel renders a bounded list. */
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const notificationCategorySchema = z.enum(["ci", "system", "home", "media"]);
const notificationSeveritySchema = z.enum(["info", "warning", "critical"]);

type NotificationCategory = z.infer<typeof notificationCategorySchema>;
type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;

export const raiseNotificationSchema = z.object({
  category: notificationCategorySchema,
  severity: notificationSeveritySchema,
  title: z.string().min(1).max(200),
  body: z.string().max(2000).nullish(),
  /** Panel route to open when the notification is tapped. */
  deepLink: z.string().max(500).nullish(),
  /** Producer-specific structured payload. */
  data: z.unknown().nullish(),
  /** Stable key that collapses repeat raises of the same condition. */
  dedupeKey: z.string().min(1).max(200).nullish(),
});

const durableNotificationIntentSchema = raiseNotificationSchema.extend({
  dedupeKey: z.string().min(1).max(200),
});

export type RaiseNotificationInput = z.infer<typeof raiseNotificationSchema>;

/** Durable boundary handler for notification intents published by other Apps. */
export const runRaiseNotificationJob: JobHandler = async (rawPayload) => {
  await raiseNotification(singletonDb, durableNotificationIntentSchema.parse(rawPayload));
};

/**
 * Feed filter. "all" is every notification; "unread" narrows to rows the user
 * has not yet read.
 */
const notificationFilterSchema = z.enum(["all", "unread"]);
export const listNotificationsSchema = z.object({
  filter: notificationFilterSchema.default("all"),
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
});

export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;

/** Wire shape of one feed item. Timestamps are ISO strings, not Date. */
export const notificationItemSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  category: notificationCategorySchema,
  severity: notificationSeveritySchema,
  title: z.string(),
  body: z.string().nullable(),
  deepLink: z.string().nullable(),
  data: z.unknown().nullable(),
  readAt: z.string().nullable(),
  dedupeKey: z.string().nullable(),
});

export type NotificationItem = z.infer<typeof notificationItemSchema>;

export const listNotificationsResultSchema = z.object({
  items: z.array(notificationItemSchema),
  unreadCount: z.number().int(),
});

export type ListNotificationsResult = z.infer<typeof listNotificationsResultSchema>;

export const registerPushTokenSchema = z.object({
  deviceId: z.string().min(1).max(200),
  token: z.string().min(1).max(500),
  platform: z.literal("ios"),
  deviceName: z.string().max(200).nullish(),
  pushEnabled: z.boolean().default(true),
});

export type RegisterPushTokenInput = z.infer<typeof registerPushTokenSchema>;

/** Mint a Stripe-style notification id (`notif_<8hex>`), per the repo ID rule. */
export function newNotificationId(): string {
  return `notif_${randomBytes(4).toString("hex")}`;
}

type Db = NodePgDatabase<typeof schema>;
type NotificationRow = typeof schema.notification.$inferSelect;

/** Map a DB row to the wire item (Dates → ISO strings). */
function toItem(row: NotificationRow): NotificationItem {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    // The DB columns are plain text (no PG enum), so narrow on read. A row
    // written by an older producer with an unknown value would fail the router's
    // output validation loudly rather than silently reaching the panel.
    category: row.category as NotificationCategory,
    severity: row.severity as NotificationSeverity,
    title: row.title,
    body: row.body,
    deepLink: row.deepLink,
    data: row.data ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    dedupeKey: row.dedupeKey,
  };
}

/**
 * Raise a notification: write (or collapse onto) the feed row, then enqueue the
 * APNs fan-out job. The job is enqueued AFTER the write so the handler can
 * always load the row it was told about.
 */
export async function raiseNotification(
  db: Db,
  input: RaiseNotificationInput,
): Promise<NotificationItem> {
  const now = new Date();
  const values = {
    id: newNotificationId(),
    createdAt: now,
    category: input.category,
    severity: input.severity,
    title: input.title,
    body: input.body ?? null,
    deepLink: input.deepLink ?? null,
    data: (input.data ?? null) as NotificationRow["data"],
    dedupeKey: input.dedupeKey ?? null,
  };

  // A poller re-raising an UNCHANGED condition on an UNREAD row (e.g. the panel
  // web app reloading on every deploy and re-running its "still behind" check)
  // is not news , it's the same fact restated. Only content that actually
  // changed, or a row the user already read, deserves a fresh unread bump and
  // another APNs push; otherwise this would re-notify on every reload/poll even
  // though nothing changed. See DEDUPE note above for the resurrect-on-repeat
  // behavior this guard narrows.
  if (values.dedupeKey) {
    const [existing] = await db
      .select()
      .from(schema.notification)
      .where(eq(schema.notification.dedupeKey, values.dedupeKey))
      .limit(1);
    if (
      existing &&
      existing.readAt === null &&
      existing.title === values.title &&
      existing.body === values.body &&
      existing.category === values.category &&
      existing.severity === values.severity &&
      existing.deepLink === values.deepLink &&
      JSON.stringify(existing.data) === JSON.stringify(values.data)
    ) {
      return toItem(existing);
    }
  }

  const insert = db.insert(schema.notification).values(values);

  // With a dedupe key, a repeat raise refreshes the existing row in place and
  // resurfaces it as unread (see the module header). Without one, every raise is
  // a new row and there is nothing to conflict on.
  const rows = input.dedupeKey
    ? await insert
        .onConflictDoUpdate({
          target: schema.notification.dedupeKey,
          set: {
            createdAt: now,
            category: values.category,
            severity: values.severity,
            title: values.title,
            body: values.body,
            deepLink: values.deepLink,
            data: values.data,
            readAt: null,
          },
        })
        .returning()
    : await insert.returning();

  const row = rows[0];
  if (!row) throw new Error("raiseNotification: insert returned no row");

  // Delivery is the queue's problem from here. A failure to enqueue must not
  // lose the feed row that already committed, so it is logged, not thrown.
  try {
    await enqueueJob(db, NOTIFY_JOB_TYPE, { notificationId: row.id });
  } catch (err) {
    getLogger().error({ err, notificationId: row.id }, "failed to enqueue notify job");
  }

  return toItem(row);
}

/** Count unread notifications. */
export async function countUnread(db: Db): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.notification)
    .where(isNull(schema.notification.readAt));
  return rows[0]?.count ?? 0;
}

/**
 * Read the feed, newest first, plus the unread badge count. The count is always
 * the true global unread total, NOT a count of the returned page , the badge
 * must not change just because the caller asked for a different filter or limit.
 */
export async function listNotifications(
  db: Db,
  input: ListNotificationsInput,
): Promise<ListNotificationsResult> {
  const { filter, limit } = input;
  const rows = await db
    .select()
    .from(schema.notification)
    .where(filter === "unread" ? isNull(schema.notification.readAt) : undefined)
    .orderBy(desc(schema.notification.createdAt))
    .limit(limit);

  return { items: rows.map(toItem), unreadCount: await countUnread(db) };
}

/**
 * Mark one notification read. Idempotent, and the timestamp is NOT refreshed on
 * a second call (`is null` guard) so "when did the user first see this" stays
 * true. Returns the new unread count so the caller can update the badge without
 * a follow-up read.
 */
export async function markRead(db: Db, id: string): Promise<{ unreadCount: number }> {
  await db
    .update(schema.notification)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notification.id, id), isNull(schema.notification.readAt)));
  return { unreadCount: await countUnread(db) };
}

/** Mark every unread notification read. Returns the (now zero) unread count. */
export async function markAllRead(db: Db): Promise<{ unreadCount: number }> {
  await db
    .update(schema.notification)
    .set({ readAt: new Date() })
    .where(isNull(schema.notification.readAt));
  return { unreadCount: await countUnread(db) };
}

/**
 * Register (or refresh) a device's APNs token. Upsert on device_id: the device
 * identity is stable but the token rotates, so a device re-registering on boot
 * updates its row rather than accumulating one per token.
 */
export async function registerPushToken(db: Db, input: RegisterPushTokenInput): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.devicePushToken)
    .values({
      deviceId: input.deviceId,
      token: input.token,
      platform: input.platform,
      deviceName: input.deviceName ?? null,
      pushEnabled: input.pushEnabled,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.devicePushToken.deviceId,
      set: {
        token: input.token,
        platform: input.platform,
        deviceName: input.deviceName ?? null,
        pushEnabled: input.pushEnabled,
        updatedAt: now,
      },
    });
}

/** Payload written by raiseNotification when enqueueing a notify job. */
interface NotifyPayload {
  notificationId: string;
}

/**
 * The `notify` job handler: load the notification, load every push-enabled
 * device, and send. Send failures are absorbed per-device by sendApnsPush (a
 * dead token must not fail the fan-out for healthy devices), so this throws only
 * when the notification row itself is missing , which is a real bug worth a
 * retry, not a delivery problem.
 *
 * @public , exported for unit testing
 */
export async function handleNotifyJob(rawPayload: unknown, db: Db = singletonDb): Promise<void> {
  const { notificationId } = rawPayload as NotifyPayload;
  const log = getLogger();

  const rows = await db
    .select()
    .from(schema.notification)
    .where(eq(schema.notification.id, notificationId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`notification not found: ${notificationId}`);

  // A notification the user already read between the raise and the job running
  // (they were watching the panel) needs no push.
  if (row.readAt) {
    log.info({ notificationId }, "notify skipped , already read");
    return;
  }

  const devices = await db
    .select()
    .from(schema.devicePushToken)
    .where(eq(schema.devicePushToken.pushEnabled, true));
  if (devices.length === 0) {
    log.info({ notificationId }, "notify: no push-enabled devices registered");
    return;
  }

  const badge = await countUnread(db);
  const alert: ApnsAlert = {
    notificationId: row.id,
    title: row.title,
    body: row.body,
    category: row.category,
    severity: row.severity,
    deepLink: row.deepLink,
    badge,
  };

  const results = await Promise.all(devices.map((d) => sendApnsPush(db, d.token, alert)));
  log.info(
    {
      notificationId,
      devices: devices.length,
      sent: results.filter((r) => r === "sent").length,
      stale: results.filter((r) => r === "stale").length,
      failed: results.filter((r) => r === "failed").length,
    },
    "notify fan-out complete",
  );
}

/** The `notify` job handler. Wired via the S1 job seam (./jobs.ts). */
export const runNotifyJob: JobHandler = async (payload) => {
  await handleNotifyJob(payload);
};
