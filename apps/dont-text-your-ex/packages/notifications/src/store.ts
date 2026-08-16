import { createHash } from "node:crypto";
import { genId } from "@www/platform";
import type { Pool, PoolClient } from "pg";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  NotificationCategorySchema,
  type NotificationDeliveryId,
  NotificationDeliveryIdSchema,
  type NotificationId,
  type NotificationPreferences,
  type NotificationTarget,
  type PushInstallationId,
  type RegisterPushDeviceRequest,
  type UpdateNotificationPreferencesRequest,
  type UserId,
} from "../../../contracts";
import type { TokenCipher } from "./token-cipher";

export type PersistedDeliveryOutcome =
  | { readonly kind: "accepted"; readonly apnsId: string | null }
  | { readonly kind: "invalid_device"; readonly reason: string }
  | { readonly kind: "permanent_notification"; readonly reason: string }
  | { readonly kind: "provider_configuration"; readonly reason: string };

export interface DeliveryForSend {
  readonly deliveryId: NotificationDeliveryId;
  readonly notificationId: NotificationId;
  readonly deviceToken: string;
  readonly environment: "production" | "sandbox";
}

type Queryable = Pick<Pool | PoolClient, "query">;

export interface NotificationStore {
  registerDevice(userId: UserId, input: RegisterPushDeviceRequest): Promise<void>;
  disableDevice(userId: UserId, installationId: PushInstallationId): Promise<void>;
  getPreferences(userId: UserId): Promise<NotificationPreferences>;
  updatePreferences(
    userId: UserId,
    patch: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferences>;
  resolveTarget(userId: UserId, notificationId: NotificationId): Promise<NotificationTarget>;
  prepareDeliveries(notificationId: NotificationId): Promise<readonly NotificationDeliveryId[]>;
  loadDelivery(deliveryId: NotificationDeliveryId): Promise<DeliveryForSend | null>;
  recordDeliveryOutcome(
    deliveryId: NotificationDeliveryId,
    outcome: PersistedDeliveryOutcome,
  ): Promise<void>;
}

function defaultPreferences(): NotificationPreferences {
  return Object.fromEntries(
    Object.entries(NOTIFICATION_CATEGORIES).map(([category, value]) => [
      category,
      value.defaultEnabled,
    ]),
  ) as NotificationPreferences;
}

function deliveryId(): NotificationDeliveryId {
  return NotificationDeliveryIdSchema.parse(genId("ndl", { length: 16 }));
}

export function createNotificationStore(
  db: Queryable,
  cipher: TokenCipher,
  clock: () => number = Date.now,
): NotificationStore {
  return {
    async registerDevice(userId, input) {
      const sealed = cipher.seal(input.token, input.installationId);
      const tokenHash = createHash("sha256").update(input.token, "utf8").digest("hex");
      const now = clock();
      const persisted = await db.query(
        `WITH disabled_duplicate AS (
           UPDATE push_device SET active=FALSE, disabled_at=$11
           WHERE token_sha256=$8 AND installation_id<>$1
         )
         INSERT INTO push_device
            (installation_id,user_id,platform,environment,token_ciphertext,token_nonce,token_key_id,token_sha256,app_version,app_build,active,last_registered_at,disabled_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,NULL)
           ON CONFLICT (installation_id) DO UPDATE SET
             user_id=EXCLUDED.user_id, platform=EXCLUDED.platform, environment=EXCLUDED.environment,
             token_ciphertext=EXCLUDED.token_ciphertext, token_nonce=EXCLUDED.token_nonce,
             token_key_id=EXCLUDED.token_key_id, token_sha256=EXCLUDED.token_sha256,
             app_version=EXCLUDED.app_version, app_build=EXCLUDED.app_build,
             active=TRUE, last_registered_at=EXCLUDED.last_registered_at, disabled_at=NULL,
             last_failure_code=NULL
           WHERE push_device.user_id=EXCLUDED.user_id OR push_device.active=FALSE
           RETURNING installation_id`,
        [
          input.installationId,
          userId,
          input.platform,
          input.environment,
          sealed.ciphertext,
          sealed.nonce,
          sealed.keyId,
          tokenHash,
          input.appVersion,
          input.appBuild,
          now,
        ],
      );
      if (!persisted.rowCount) throw new Error("push installation belongs to another account");
    },

    async disableDevice(userId, installationId) {
      await db.query(
        "UPDATE push_device SET active=FALSE, disabled_at=$1 WHERE installation_id=$2 AND user_id=$3",
        [clock(), installationId, userId],
      );
    },

    async getPreferences(userId) {
      const result = await db.query<{ category: string; enabled: boolean }>(
        "SELECT category, enabled FROM notification_preference WHERE user_id=$1",
        [userId],
      );
      const preferences = defaultPreferences();
      for (const row of result.rows) {
        const category = NotificationCategorySchema.safeParse(row.category);
        if (category.success) preferences[category.data] = row.enabled;
      }
      return preferences;
    },

    async updatePreferences(userId, patch) {
      const now = clock();
      for (const [category, enabled] of Object.entries(patch)) {
        await db.query(
          `INSERT INTO notification_preference (user_id,category,enabled,updated_at)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id,category) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=EXCLUDED.updated_at`,
          [userId, category, enabled, now],
        );
      }
      return this.getPreferences(userId);
    },

    async resolveTarget(userId, notificationId) {
      const result = await db.query<{
        target_type: "activity" | "report" | "jar" | "profile";
        target_id: string | null;
      }>(
        `SELECT target_type,target_id FROM user_notification
         WHERE id=$1 AND recipient_user_id=$2 AND cancelled_at IS NULL
           AND (expires_at IS NULL OR expires_at>$3)`,
        [notificationId, userId, clock()],
      );
      const row = result.rows[0];
      if (!row) return { type: "unavailable" };
      if (row.target_type === "report" && row.target_id) {
        const authorized = await db.query(
          `SELECT 1 FROM reports r JOIN memberships m ON m.jar_id=r.jar_id
           WHERE r.id=$1 AND m.user_id=$2 AND m.left_at IS NULL LIMIT 1`,
          [row.target_id, userId],
        );
        return authorized.rowCount
          ? { type: "report", reportId: row.target_id }
          : { type: "unavailable" };
      }
      if (row.target_type === "jar" && row.target_id) {
        const authorized = await db.query(
          "SELECT 1 FROM memberships WHERE jar_id=$1 AND user_id=$2 LIMIT 1",
          [row.target_id, userId],
        );
        return authorized.rowCount
          ? { type: "jar", jarId: row.target_id }
          : { type: "unavailable" };
      }
      return row.target_type === "activity" || row.target_type === "profile"
        ? { type: row.target_type }
        : { type: "unavailable" };
    },

    async prepareDeliveries(notificationId) {
      const result = await db.query<{ recipient_user_id: UserId; category: NotificationCategory }>(
        `SELECT recipient_user_id,category FROM user_notification
         WHERE id=$1 AND cancelled_at IS NULL AND (expires_at IS NULL OR expires_at>$2)`,
        [notificationId, clock()],
      );
      const notification = result.rows[0];
      if (!notification) return [];
      const preferences = await this.getPreferences(notification.recipient_user_id);
      if (!preferences[notification.category]) return [];
      const devices = await db.query<{ installation_id: PushInstallationId }>(
        "SELECT installation_id FROM push_device WHERE user_id=$1 AND active=TRUE ORDER BY installation_id",
        [notification.recipient_user_id],
      );
      const ids: NotificationDeliveryId[] = [];
      for (const device of devices.rows) {
        const id = deliveryId();
        const inserted = await db.query<{ id: NotificationDeliveryId }>(
          `INSERT INTO notification_delivery (id,notification_id,installation_id,status,created_at,updated_at)
           VALUES ($1,$2,$3,'pending',$4,$4)
           ON CONFLICT (notification_id,installation_id) DO UPDATE SET updated_at=notification_delivery.updated_at
           RETURNING id`,
          [id, notificationId, device.installation_id, clock()],
        );
        const persisted = inserted.rows[0];
        if (persisted) ids.push(persisted.id);
      }
      return ids;
    },

    async loadDelivery(deliveryId) {
      const result = await db.query<{
        delivery_id: NotificationDeliveryId;
        notification_id: NotificationId;
        installation_id: PushInstallationId;
        token_ciphertext: string;
        token_nonce: string;
        token_key_id: string;
        environment: "production" | "sandbox";
      }>(
        `SELECT d.id AS delivery_id,d.notification_id,p.installation_id,p.token_ciphertext,
                p.token_nonce,p.token_key_id,p.environment
         FROM notification_delivery d JOIN push_device p ON p.installation_id=d.installation_id
         WHERE d.id=$1 AND d.status='pending' AND p.active=TRUE`,
        [deliveryId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        deliveryId: row.delivery_id,
        notificationId: row.notification_id,
        environment: row.environment,
        deviceToken: cipher.open(
          { keyId: row.token_key_id, nonce: row.token_nonce, ciphertext: row.token_ciphertext },
          row.installation_id,
        ),
      };
    },

    async recordDeliveryOutcome(deliveryId, outcome) {
      const status =
        outcome.kind === "accepted"
          ? "accepted"
          : outcome.kind === "invalid_device"
            ? "invalid_device"
            : "permanent_failure";
      const failureCode = outcome.kind === "accepted" ? null : outcome.reason;
      const apnsId = outcome.kind === "accepted" ? outcome.apnsId : null;
      await db.query(
        `WITH updated AS (
           UPDATE notification_delivery SET status=$2,attempt_count=attempt_count+1,
             apns_id=$3,failure_code=$4,updated_at=$5 WHERE id=$1
           RETURNING installation_id
         )
         UPDATE push_device SET
           active=CASE WHEN $2='invalid_device' THEN FALSE ELSE active END,
           disabled_at=CASE WHEN $2='invalid_device' THEN $5 ELSE disabled_at END,
           last_success_at=CASE WHEN $2='accepted' THEN $5 ELSE last_success_at END,
           last_failure_code=CASE WHEN $2='accepted' THEN NULL ELSE $4 END
         WHERE installation_id=(SELECT installation_id FROM updated)`,
        [deliveryId, status, apnsId, failureCode, clock()],
      );
    },
  };
}
