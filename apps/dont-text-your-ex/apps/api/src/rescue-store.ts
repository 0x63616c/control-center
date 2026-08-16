import type { Pool, PoolClient } from "pg";
import {
  type RescueCommandRequest,
  type RescueIntervention,
  type RescueInterventionId,
  RescueInterventionIdSchema,
  RescueInterventionSchema,
  type UserId,
} from "../../../contracts";
import { DomainTransactionRunner } from "./domain-transaction";
import { id } from "./ids";

const TEN_MINUTES_MS = 10 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const THIRTY_MINUTES_MS = 30 * 60_000;

type RescueRow = {
  id: string;
  user_id: string;
  state: RescueIntervention["status"];
  started_at: string;
  deadline_at: string;
  extension_count: number;
  aggregate_version: string;
  check_in_due_at: string | null;
  response_deadline_at: string | null;
  resolved_at: string | null;
  updated_at: string;
};

export type RescueCommandOutcome =
  | Readonly<{ outcome: "applied"; intervention: RescueIntervention }>
  | Readonly<{ outcome: "terminal"; intervention: RescueIntervention }>
  | Readonly<{ outcome: "ineligible"; intervention: RescueIntervention }>
  | Readonly<{ outcome: "not_found" }>;

export interface RescueStore {
  start(userId: UserId): Promise<RescueIntervention>;
  current(userId: UserId): Promise<RescueIntervention | null>;
  load(interventionId: RescueInterventionId): Promise<RescueIntervention | null>;
  command(
    input: Readonly<{
      userId: UserId;
      interventionId: RescueInterventionId;
      action: RescueCommandRequest["action"];
    }>,
  ): Promise<RescueCommandOutcome>;
  advanceAtDeadline(
    input: Readonly<{
      interventionId: RescueInterventionId;
      expectedAggregateVersion: number;
    }>,
  ): Promise<RescueIntervention | null>;
  eraseForAccountDeletion(interventionId: RescueInterventionId): Promise<void>;
}

function parseRow(row: RescueRow): RescueIntervention {
  const common = {
    id: RescueInterventionIdSchema.parse(row.id),
    status: row.state,
    startedAt: Number(row.started_at),
    deadlineAt: Number(row.deadline_at),
    extensionCount: row.extension_count,
    aggregateVersion: Number(row.aggregate_version),
    updatedAt: Number(row.updated_at),
  };
  switch (row.state) {
    case "active":
      return RescueInterventionSchema.parse(common);
    case "check_in_due":
      return RescueInterventionSchema.parse({
        ...common,
        checkInDueAt: Number(row.check_in_due_at),
        responseDeadlineAt: Number(row.response_deadline_at),
      });
    case "safe":
    case "slipped":
    case "abandoned":
      return RescueInterventionSchema.parse({ ...common, resolvedAt: Number(row.resolved_at) });
  }
}

const RETURNING_RESCUE = `RETURNING id,user_id,state,started_at,deadline_at,extension_count,
  aggregate_version,check_in_due_at,response_deadline_at,resolved_at,updated_at`;

export class PostgresRescueStore implements RescueStore {
  readonly #pool: Pick<Pool, "connect" | "query">;
  readonly #transactions: DomainTransactionRunner;
  readonly #clock: () => number;

  constructor(pool: Pick<Pool, "connect" | "query">, clock: () => number = Date.now) {
    this.#pool = pool;
    this.#clock = clock;
    this.#transactions = new DomainTransactionRunner({ pool, clock });
  }

  async start(userId: UserId): Promise<RescueIntervention> {
    return this.#transactions.run(async ({ db, emit }) => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [userId]);
      const existing = await this.#latestForUser(db, userId, true);
      if (existing && (existing.status === "active" || existing.status === "check_in_due")) {
        return existing;
      }
      const now = this.#clock();
      const interventionId = id("rsi");
      const inserted = await db.query<RescueRow>(
        `INSERT INTO rescue_interventions
           (id,user_id,state,started_at,deadline_at,extension_count,aggregate_version,updated_at)
         VALUES ($1,$2,'active',$3,$4,0,1,$3) ${RETURNING_RESCUE}`,
        [interventionId, userId, now, now + TEN_MINUTES_MS],
      );
      await emit({ type: "rescue.started", aggregateId: interventionId, aggregateVersion: 1 });
      const row = inserted.rows[0];
      if (!row) throw new Error("rescue intervention insert returned no row");
      return parseRow(row);
    });
  }

  current(userId: UserId): Promise<RescueIntervention | null> {
    return this.#latestForUser(this.#pool, userId, false);
  }

  async load(interventionId: RescueInterventionId): Promise<RescueIntervention | null> {
    const result = await this.#pool.query<RescueRow>(
      `SELECT id,user_id,state,started_at,deadline_at,extension_count,aggregate_version,
              check_in_due_at,response_deadline_at,resolved_at,updated_at
       FROM rescue_interventions WHERE id=$1`,
      [interventionId],
    );
    return result.rows[0] ? parseRow(result.rows[0]) : null;
  }

  command(
    input: Readonly<{
      userId: UserId;
      interventionId: RescueInterventionId;
      action: RescueCommandRequest["action"];
    }>,
  ): Promise<RescueCommandOutcome> {
    return this.#transactions.run(async ({ db, emit }) => {
      const result = await db.query<RescueRow>(
        `SELECT id,user_id,state,started_at,deadline_at,extension_count,aggregate_version,
                check_in_due_at,response_deadline_at,resolved_at,updated_at
         FROM rescue_interventions WHERE id=$1 AND user_id=$2 FOR UPDATE`,
        [input.interventionId, input.userId],
      );
      const row = result.rows[0];
      if (!row) return { outcome: "not_found" };
      const current = parseRow(row);
      if (
        current.status === "safe" ||
        current.status === "slipped" ||
        current.status === "abandoned"
      ) {
        return input.action === current.status
          ? { outcome: "applied", intervention: current }
          : { outcome: "terminal", intervention: current };
      }

      const now = this.#clock();
      const absoluteDeadline = current.startedAt + THIRTY_MINUTES_MS;
      const responseLimit =
        current.status === "check_in_due"
          ? current.responseDeadlineAt
          : current.deadlineAt >= absoluteDeadline
            ? current.deadlineAt
            : current.deadlineAt + FIVE_MINUTES_MS;
      if (now >= responseLimit) {
        return { outcome: "ineligible", intervention: current };
      }
      const nextVersion = current.aggregateVersion + 1;
      if (input.action === "extend") {
        const nextDeadline = current.deadlineAt + TEN_MINUTES_MS;
        if (current.extensionCount >= 2 || nextDeadline > absoluteDeadline) {
          return { outcome: "ineligible", intervention: current };
        }
        const updated = await db.query<RescueRow>(
          `UPDATE rescue_interventions SET state='active',deadline_at=$3,
             extension_count=extension_count+1,aggregate_version=$4,
             check_in_due_at=NULL,response_deadline_at=NULL,updated_at=$5
           WHERE id=$1 AND user_id=$2 ${RETURNING_RESCUE}`,
          [input.interventionId, input.userId, nextDeadline, nextVersion, now],
        );
        await emit({
          type: "rescue.extended",
          aggregateId: input.interventionId,
          aggregateVersion: nextVersion,
        });
        const updatedRow = updated.rows[0];
        if (!updatedRow) throw new Error("rescue extension lost locked row");
        return { outcome: "applied", intervention: parseRow(updatedRow) };
      }

      const state = input.action;
      const updated = await db.query<RescueRow>(
        `UPDATE rescue_interventions SET state=$3,resolved_at=$4,aggregate_version=$5,updated_at=$4
         WHERE id=$1 AND user_id=$2 ${RETURNING_RESCUE}`,
        [input.interventionId, input.userId, state, now, nextVersion],
      );
      await emit({
        type: state === "safe" ? "rescue.safe" : "rescue.slipped",
        aggregateId: input.interventionId,
        aggregateVersion: nextVersion,
      });
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new Error("rescue resolution lost locked row");
      return { outcome: "applied", intervention: parseRow(updatedRow) };
    });
  }

  advanceAtDeadline(
    input: Readonly<{
      interventionId: RescueInterventionId;
      expectedAggregateVersion: number;
    }>,
  ): Promise<RescueIntervention | null> {
    return this.#transactions.run(async ({ db, emit }) => {
      const result = await db.query<RescueRow>(
        `SELECT id,user_id,state,started_at,deadline_at,extension_count,aggregate_version,
                check_in_due_at,response_deadline_at,resolved_at,updated_at
         FROM rescue_interventions WHERE id=$1 FOR UPDATE`,
        [input.interventionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      const current = parseRow(row);
      if (current.aggregateVersion !== input.expectedAggregateVersion) return current;
      if (
        current.status === "safe" ||
        current.status === "slipped" ||
        current.status === "abandoned"
      ) {
        return current;
      }
      const now = this.#clock();
      const shouldAbandon =
        (current.status === "active" &&
          current.deadlineAt >= current.startedAt + THIRTY_MINUTES_MS &&
          now >= current.deadlineAt) ||
        (current.status === "check_in_due" && now >= current.responseDeadlineAt);
      if (shouldAbandon) {
        const nextVersion = current.aggregateVersion + 1;
        const abandoned = await db.query<RescueRow>(
          `UPDATE rescue_interventions SET state='abandoned',resolved_at=$2,
             aggregate_version=$3,updated_at=$2 WHERE id=$1 ${RETURNING_RESCUE}`,
          [input.interventionId, now, nextVersion],
        );
        await emit({
          type: "rescue.abandoned",
          aggregateId: input.interventionId,
          aggregateVersion: nextVersion,
        });
        const abandonedRow = abandoned.rows[0];
        if (!abandonedRow) throw new Error("rescue abandonment lost locked row");
        return parseRow(abandonedRow);
      }
      if (current.status === "check_in_due" || now < current.deadlineAt) return current;

      const nextVersion = current.aggregateVersion + 1;
      const responseDeadline = current.deadlineAt + FIVE_MINUTES_MS;
      const due = await db.query<RescueRow>(
        `UPDATE rescue_interventions SET state='check_in_due',check_in_due_at=$2,
           response_deadline_at=$3,aggregate_version=$4,updated_at=$2
         WHERE id=$1 ${RETURNING_RESCUE}`,
        [input.interventionId, now, responseDeadline, nextVersion],
      );
      const notificationId = id("ntf");
      await db.query(
        `INSERT INTO user_notification
           (id,recipient_user_id,category,dedupe_key,target_type,target_id,message_key,created_at,expires_at)
         VALUES ($1,$2,'rescue',$3,'profile',NULL,'rescue.check_in',$4,$5)
         ON CONFLICT (recipient_user_id,dedupe_key) DO NOTHING`,
        [
          notificationId,
          row.user_id,
          `rescue-check-in:${input.interventionId}:${current.extensionCount}`,
          now,
          responseDeadline,
        ],
      );
      await emit({
        type: "rescue.check_in_due",
        aggregateId: input.interventionId,
        aggregateVersion: nextVersion,
      });
      await emit({
        type: "notification.requested",
        aggregateId: notificationId,
        aggregateVersion: 1,
      });
      const dueRow = due.rows[0];
      if (!dueRow) throw new Error("rescue check-in lost locked row");
      return parseRow(dueRow);
    });
  }

  async eraseForAccountDeletion(interventionId: RescueInterventionId): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const now = this.#clock();
      await client.query(
        `UPDATE notification_delivery SET status='suppressed',updated_at=$2
         WHERE status='pending' AND notification_id IN (
           SELECT id FROM user_notification WHERE category='rescue' AND dedupe_key LIKE $1
         )`,
        [`rescue-check-in:${interventionId}:%`, now],
      );
      await client.query(
        `UPDATE user_notification SET cancelled_at=$2
         WHERE category='rescue' AND dedupe_key LIKE $1 AND cancelled_at IS NULL`,
        [`rescue-check-in:${interventionId}:%`, now],
      );
      await client.query("DELETE FROM rescue_interventions WHERE id=$1", [interventionId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #latestForUser(
    db: Pick<Pool | PoolClient, "query">,
    userId: UserId,
    lock: boolean,
  ): Promise<RescueIntervention | null> {
    const result = await db.query<RescueRow>(
      `SELECT id,user_id,state,started_at,deadline_at,extension_count,aggregate_version,
              check_in_due_at,response_deadline_at,resolved_at,updated_at
       FROM rescue_interventions WHERE user_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1${
         lock ? " FOR UPDATE" : ""
}`,
      [userId],
    );
    return result.rows[0] ? parseRow(result.rows[0]) : null;
  }
}
