import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  type NotificationId,
  NotificationIdSchema,
  type ReportId,
  ReportIdSchema,
  ReportStatusSchema,
} from "../../../contracts";
import { id } from "../../api/src/ids";

const REPORT_ACCOUNTABILITY_ACTIONS = [
  "inspect",
  "remind_immediate",
  "remind_24h",
  "remind_72h",
  "expire",
] as const;
export type ReportAccountabilityAction = (typeof REPORT_ACCOUNTABILITY_ACTIONS)[number];

const REPORT_ACCOUNTABILITY_TERMINAL_STATES = [
  "owned",
  "denied",
  "expired",
  "jar_closed",
  "member_departed",
  "account_deleted",
] as const;
export type ReportAccountabilityTerminalState =
  (typeof REPORT_ACCOUNTABILITY_TERMINAL_STATES)[number];

export type ReportAccountabilityProgress =
  | Readonly<{
      state: "pending";
      reportId: ReportId;
      aggregateVersion: number;
      createdAt: number;
    }>
  | Readonly<{
      state: ReportAccountabilityTerminalState;
      reportId: ReportId;
      aggregateVersion: number;
    }>;

export interface ReportAccountabilityStore {
  advance(
    input: Readonly<{
      reportId: ReportId;
      action: ReportAccountabilityAction;
      expectedAggregateVersion?: number;
    }>,
  ): Promise<ReportAccountabilityProgress>;
}

type ReportRow = Readonly<{
  id: ReportId;
  jar_id: string;
  accuser_id: string;
  accused_id: string;
  status: "pending" | "owned" | "denied" | "expired";
  resolution_reason: "timeout" | "account_deleted" | null;
  created_at: number;
  aggregate_version: number;
}>;

type ReportDbRow = Omit<
  ReportRow,
  "id" | "status" | "resolution_reason" | "created_at" | "aggregate_version"
> &
  Readonly<{
    id: string;
    status: string;
    resolution_reason: string | null;
    created_at: string;
    aggregate_version: string;
  }>;

const AggregateVersionSchema = z.coerce.number().int().positive();
const TimestampSchema = z.coerce.number().int().nonnegative();
const ResolutionReasonSchema = z.enum(["timeout", "account_deleted"]).nullable();

function parseReportRow(row: ReportDbRow): ReportRow {
  return {
    ...row,
    id: ReportIdSchema.parse(row.id),
    status: ReportStatusSchema.parse(row.status),
    resolution_reason: ResolutionReasonSchema.parse(row.resolution_reason),
    created_at: TimestampSchema.parse(row.created_at),
    aggregate_version: AggregateVersionSchema.parse(row.aggregate_version),
  };
}

type Eligibility =
  | Readonly<{ state: "pending"; row: ReportRow }>
  | Readonly<{ state: ReportAccountabilityTerminalState; row: ReportRow | null }>;

const reminderStage = {
  remind_immediate: "immediate",
  remind_24h: "24h",
  remind_72h: "72h",
} as const satisfies Record<Exclude<ReportAccountabilityAction, "inspect" | "expire">, string>;

function terminalProgress(
  reportId: ReportId,
  state: ReportAccountabilityTerminalState,
  row: ReportRow | null,
): ReportAccountabilityProgress {
  return {
    state,
    reportId,
    aggregateVersion: row?.aggregate_version ?? 1,
  };
}

async function eligibility(db: PoolClient, reportId: ReportId): Promise<Eligibility> {
  const result = await db.query<ReportDbRow>("SELECT * FROM reports WHERE id=$1 FOR UPDATE", [
    reportId,
  ]);
  const row = result.rows[0] ? parseReportRow(result.rows[0]) : null;
  if (!row) return { state: "member_departed", row: null };
  if (row.status === "expired" && row.resolution_reason === "account_deleted") {
    return { state: "account_deleted", row };
  }
  if (row.status === "owned" || row.status === "denied" || row.status === "expired") {
    return { state: row.status, row };
  }
  if (row.status !== "pending") return { state: "member_departed", row };
  const active = await db.query<{ closed_at: string | null; left_at: string | null }>(
    `SELECT j.closed_at,m.left_at
     FROM jars j
     LEFT JOIN memberships m ON m.jar_id=j.id AND m.user_id=$2
     WHERE j.id=$1`,
    [row.jar_id, row.accused_id],
  );
  const membership = active.rows[0];
  if (!membership || membership.left_at != null) return { state: "member_departed", row };
  if (membership.closed_at != null) return { state: "jar_closed", row };
  return { state: "pending", row };
}

async function emitNotificationRequested(
  db: PoolClient,
  notificationId: NotificationId,
  occurredAt: number,
): Promise<void> {
  await db.query(
    `INSERT INTO domain_event
       (id,event_type,schema_version,aggregate_type,aggregate_id,
        aggregate_version,occurred_at,available_at)
     VALUES ($1,'notification.requested',1,'notification',$2,1,$3,$3)
     ON CONFLICT (aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`,
    [id("evt"), notificationId, occurredAt],
  );
}

async function createNotification(
  db: PoolClient,
  input: Readonly<{
    reportId: ReportId;
    recipientUserId: string;
    dedupeKey: string;
    messageKey: "report.pending" | "report.expired";
    now: number;
    expiresAt: number | null;
  }>,
): Promise<void> {
  const notificationId = NotificationIdSchema.parse(id("ntf"));
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO user_notification
       (id,recipient_user_id,category,dedupe_key,target_type,target_id,
        message_key,created_at,expires_at)
     VALUES ($1,$2,'report',$3,'report',$4,$5,$6,$7)
     ON CONFLICT (recipient_user_id,dedupe_key) DO NOTHING
     RETURNING id`,
    [
      notificationId,
      input.recipientUserId,
      input.dedupeKey,
      input.reportId,
      input.messageKey,
      input.now,
      input.expiresAt,
    ],
  );
  if (inserted.rows[0]) await emitNotificationRequested(db, notificationId, input.now);
}

export class PostgresReportAccountabilityStore implements ReportAccountabilityStore {
  constructor(
    private readonly pool: Pick<Pool, "connect" | "query">,
    private readonly clock: () => number = Date.now,
  ) {}

  async advance(
    input: Readonly<{
      reportId: ReportId;
      action: ReportAccountabilityAction;
      expectedAggregateVersion?: number;
    }>,
  ) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const current = await eligibility(db, input.reportId);
      if (
        input.expectedAggregateVersion != null &&
        current.row != null &&
        current.row.aggregate_version < input.expectedAggregateVersion
      ) {
        throw new Error("report aggregate version is not visible yet");
      }
      if (current.state !== "pending") {
        await db.query("COMMIT");
        return terminalProgress(input.reportId, current.state, current.row);
      }
      const now = this.clock();
      if (input.action === "expire") {
        const expired = await db.query<{ aggregate_version: string }>(
          `UPDATE reports
           SET status='expired',resolution_reason='timeout',resolved_at=$2,
               aggregate_version=aggregate_version+1
           WHERE id=$1 AND status='pending'
           RETURNING aggregate_version`,
          [input.reportId, now],
        );
        const version = AggregateVersionSchema.parse(expired.rows[0]?.aggregate_version);
        await db.query(
          `INSERT INTO domain_event
             (id,event_type,schema_version,aggregate_type,aggregate_id,
              aggregate_version,occurred_at,available_at)
           VALUES ($1,'report.expired',1,'report',$2,$3,$4,$4)
           ON CONFLICT (aggregate_type,aggregate_id,aggregate_version,event_type) DO NOTHING`,
          [id("evt"), input.reportId, version, now],
        );
        await createNotification(db, {
          reportId: input.reportId,
          recipientUserId: current.row.accuser_id,
          dedupeKey: `report/${input.reportId}/expired`,
          messageKey: "report.expired",
          now,
          expiresAt: null,
        });
        await db.query("COMMIT");
        return terminalProgress(input.reportId, "expired", {
          ...current.row,
          aggregate_version: version,
        });
      }
      if (input.action !== "inspect") {
        await createNotification(db, {
          reportId: input.reportId,
          recipientUserId: current.row.accused_id,
          dedupeKey: `report/${input.reportId}/${reminderStage[input.action]}`,
          messageKey: "report.pending",
          now,
          expiresAt: current.row.created_at + 7 * 86_400_000,
        });
      }
      await db.query("COMMIT");
      return {
        state: "pending" as const,
        reportId: input.reportId,
        aggregateVersion: current.row.aggregate_version,
        createdAt: current.row.created_at,
      };
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }
}

export function createReportAccountabilityActivities(dependencies: {
  readonly store: ReportAccountabilityStore;
}) {
  return {
    async ReportAccountabilityActivity(input: {
      readonly reportId: ReportId;
      readonly action: ReportAccountabilityAction;
      readonly expectedAggregateVersion?: number;
    }): Promise<ReportAccountabilityProgress> {
      return dependencies.store.advance(input);
    },
  };
}

export type ReportAccountabilityActivities = ReturnType<
  typeof createReportAccountabilityActivities
>;
