import { z } from "zod";
import {
  CalendarMonthSchema,
  IanaTimeZoneSchema,
  JarIdSchema,
  JarRecapSchema,
  NotificationIdSchema,
  parseSharedStreakMilestoneActivityText,
  RecapIdSchema,
  UserIdSchema,
} from "../../../contracts";
import type {
  DomainTransactionContext,
  DomainTransactionRunner,
} from "../../api/src/domain-transaction";
import { id } from "../../api/src/ids";

export interface MonthlyRecapPageInput {
  readonly cutoff: number;
  readonly limit: number;
}

export interface MonthlyRecapPageResult {
  readonly candidates: number;
  readonly recaps: number;
  readonly recipients: number;
  readonly notifications: number;
  readonly hasMore: boolean;
}

export interface MonthlyRecapStore {
  generatePage(input: MonthlyRecapPageInput): Promise<MonthlyRecapPageResult>;
}

const CandidateRowSchema = z.object({
  jar_id: JarIdSchema,
  calendar_month: CalendarMonthSchema,
});
const SnapshotRowSchema = z.object({
  jar_id: JarIdSchema,
  jar_name: z.string(),
  timezone: IanaTimeZoneSchema,
  period_start_at: z.string().regex(/^\d+$/),
  period_end_at: z.string().regex(/^\d+$/),
  slip_count: z.string().regex(/^\d+$/),
  total_amount_cents: z.string().regex(/^\d+$/),
});
const RecipientRowSchema = z.object({
  user_id: UserIdSchema,
  notifications_enabled: z.boolean(),
});
const SharedStreakActivityRowSchema = z.object({ text: z.string().nullable() });
const MilestoneRowSchema = z.object({ threshold_cents: z.number().int().positive() });

type CandidateRow = z.infer<typeof CandidateRowSchema>;

function parseNonnegativeSafeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${field}`);
  return parsed;
}

export class PostgresMonthlyRecapStore implements MonthlyRecapStore {
  constructor(private readonly transactions: Pick<DomainTransactionRunner, "run">) {}

  async generatePage(input: MonthlyRecapPageInput): Promise<MonthlyRecapPageResult> {
    if (!Number.isSafeInteger(input.cutoff) || input.cutoff < 0) {
      throw new Error("invalid monthly recap cutoff");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error("monthly recap limit must be between 1 and 100");
    }
    return this.transactions.run((context) => this.#generatePage(context, input));
  }

  async #generatePage(
    context: DomainTransactionContext,
    input: MonthlyRecapPageInput,
  ): Promise<MonthlyRecapPageResult> {
    const candidateResult = await context.db.query<Record<string, unknown>>(
      `WITH activity_months AS (
         SELECT DISTINCT a.jar_id,
           to_char(to_timestamp(a.created_at / 1000.0) AT TIME ZONE j.timezone,'YYYY-MM')
             AS calendar_month
         FROM activity a
         JOIN jars j ON j.id=a.jar_id
         WHERE a.created_at < $1
           AND to_char(to_timestamp(a.created_at / 1000.0) AT TIME ZONE j.timezone,'YYYY-MM')
             < to_char(to_timestamp($1 / 1000.0) AT TIME ZONE j.timezone,'YYYY-MM')
       )
       SELECT am.jar_id,am.calendar_month
       FROM activity_months am
       WHERE NOT EXISTS (
         SELECT 1 FROM jar_recaps r
         WHERE r.jar_id=am.jar_id AND r.calendar_month=am.calendar_month
       )
       ORDER BY am.calendar_month,am.jar_id
       LIMIT $2`,
      [input.cutoff, input.limit + 1],
    );
    const candidates = candidateResult.rows
      .slice(0, input.limit)
      .map((row) => CandidateRowSchema.parse(row));
    let recaps = 0;
    let recipients = 0;
    let notifications = 0;
    for (const candidate of candidates) {
      const inserted = await this.#createSnapshot(context, candidate, input.cutoff);
      recaps += inserted.recaps;
      recipients += inserted.recipients;
      notifications += inserted.notifications;
    }
    return {
      candidates: candidates.length,
      recaps,
      recipients,
      notifications,
      hasMore: candidateResult.rows.length > input.limit,
    };
  }

  async #createSnapshot(
    { db, emit }: DomainTransactionContext,
    candidate: CandidateRow,
    createdAt: number,
  ): Promise<Pick<MonthlyRecapPageResult, "recaps" | "recipients" | "notifications">> {
    await db.query("SELECT id FROM jars WHERE id=$1 FOR UPDATE", [candidate.jar_id]);
    const existing = await db.query(
      "SELECT 1 FROM jar_recaps WHERE jar_id=$1 AND calendar_month=$2",
      [candidate.jar_id, candidate.calendar_month],
    );
    if (existing.rows[0]) return { recaps: 0, recipients: 0, notifications: 0 };

    const snapshot = await db.query<Record<string, unknown>>(
      `SELECT j.id AS jar_id,j.name AS jar_name,j.timezone,
              (EXTRACT(EPOCH FROM (($2 || '-01')::timestamp AT TIME ZONE j.timezone))*1000)::bigint::text
                AS period_start_at,
              (EXTRACT(EPOCH FROM ((($2 || '-01')::timestamp + INTERVAL '1 month')
                AT TIME ZONE j.timezone))*1000)::bigint::text AS period_end_at,
              COUNT(s.id)::text AS slip_count,
              COALESCE(SUM(s.amount_cents),0)::text AS total_amount_cents
       FROM jars j
       LEFT JOIN slips s ON s.jar_id=j.id
         AND s.created_at >= EXTRACT(EPOCH FROM (($2 || '-01')::timestamp AT TIME ZONE j.timezone))*1000
         AND s.created_at < EXTRACT(EPOCH FROM ((($2 || '-01')::timestamp + INTERVAL '1 month')
           AT TIME ZONE j.timezone))*1000
       WHERE j.id=$1
       GROUP BY j.id,j.name,j.timezone`,
      [candidate.jar_id, candidate.calendar_month],
    );
    const row = SnapshotRowSchema.parse(snapshot.rows[0]);
    if (!row) throw new Error("monthly recap jar disappeared");
    const periodStartAt = parseNonnegativeSafeInteger(row.period_start_at, "period start");
    const periodEndAt = parseNonnegativeSafeInteger(row.period_end_at, "period end");
    const slipCount = parseNonnegativeSafeInteger(row.slip_count, "slip count");
    const totalAmountCents = parseNonnegativeSafeInteger(row.total_amount_cents, "total amount");
    const streakActivities = await db.query<Record<string, unknown>>(
      `SELECT a.text
       FROM activity a
       WHERE a.jar_id=$1 AND a.type='milestone'
         AND a.created_at >= $2 AND a.created_at < $3
       ORDER BY a.created_at,a.id`,
      [candidate.jar_id, periodStartAt, periodEndAt],
    );
    const streakCounts = new Map<number, number>();
    for (const persisted of streakActivities.rows) {
      const activity = SharedStreakActivityRowSchema.parse(persisted);
      const days = parseSharedStreakMilestoneActivityText(activity.text);
      if (days === null) continue;
      streakCounts.set(days, (streakCounts.get(days) ?? 0) + 1);
    }
    const milestones = await db.query<Record<string, unknown>>(
      `SELECT threshold_cents FROM jar_milestones
       WHERE jar_id=$1 AND reached_at >= $2 AND reached_at < $3
       ORDER BY threshold_cents`,
      [candidate.jar_id, periodStartAt, periodEndAt],
    );
    const recapId = RecapIdSchema.parse(id("rcp"));
    const parsedSnapshot = JarRecapSchema.parse({
      id: recapId,
      jarId: row.jar_id,
      jarName: row.jar_name,
      calendarMonth: candidate.calendar_month,
      timezone: row.timezone,
      periodStartAt,
      periodEndAt,
      slipCount,
      totalAmountCents,
      tallyChangeCents: totalAmountCents,
      sharedStreakHighlights: [...streakCounts.entries()].map(([days, count]) => ({ days, count })),
      crossedMilestonesCents: milestones.rows.map(
        (milestone) => MilestoneRowSchema.parse(milestone).threshold_cents,
      ),
      createdAt,
    });
    await db.query(
      `INSERT INTO jar_recaps
         (id,jar_id,calendar_month,timezone,period_start_at,period_end_at,slip_count,
          total_amount_cents,tally_change_cents,shared_streak_highlights,
          crossed_milestones_cents,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)`,
      [
        parsedSnapshot.id,
        parsedSnapshot.jarId,
        parsedSnapshot.calendarMonth,
        parsedSnapshot.timezone,
        parsedSnapshot.periodStartAt,
        parsedSnapshot.periodEndAt,
        parsedSnapshot.slipCount,
        parsedSnapshot.totalAmountCents,
        parsedSnapshot.tallyChangeCents,
        JSON.stringify(parsedSnapshot.sharedStreakHighlights),
        JSON.stringify(parsedSnapshot.crossedMilestonesCents),
        parsedSnapshot.createdAt,
      ],
    );
    const recipientResult = await db.query<Record<string, unknown>>(
      `SELECT m.user_id,COALESCE(pref.enabled,FALSE) AS notifications_enabled
       FROM memberships m
       LEFT JOIN notification_preference pref
         ON pref.user_id=m.user_id AND pref.category='recap'
       WHERE m.jar_id=$1 AND m.left_at IS NULL
         AND EXISTS (
           SELECT 1 FROM membership_tenures mt
           WHERE mt.membership_id=m.id AND mt.joined_at < $3
             AND (mt.left_at IS NULL OR mt.left_at >= $2)
         )
       ORDER BY m.user_id`,
      [candidate.jar_id, periodStartAt, periodEndAt],
    );
    const parsedRecipients = recipientResult.rows.map((row) => RecipientRowSchema.parse(row));
    for (const recipient of parsedRecipients) {
      await db.query(
        "INSERT INTO jar_recap_recipients (recap_id,user_id,eligible_at) VALUES ($1,$2,$3)",
        [recapId, recipient.user_id, createdAt],
      );
      if (!recipient.notifications_enabled) continue;
      const notificationId = NotificationIdSchema.parse(id("ntf"));
      await db.query(
        `INSERT INTO user_notification
           (id,recipient_user_id,category,dedupe_key,target_type,target_id,message_key,created_at)
         VALUES ($1,$2,'recap',$3,'jar',$4,'recap.ready',$5)`,
        [notificationId, recipient.user_id, `recap:${recapId}`, candidate.jar_id, createdAt],
      );
      await emit({
        type: "notification.requested",
        aggregateId: notificationId,
        aggregateVersion: 1,
      });
    }
    await emit({ type: "recap.created", aggregateId: recapId, aggregateVersion: 1 });
    return {
      recaps: 1,
      recipients: parsedRecipients.length,
      notifications: parsedRecipients.filter((recipient) => recipient.notifications_enabled).length,
    };
  }
}

export interface MonthlyRecapActivities {
  MonthlyJarRecapActivity(input: MonthlyRecapPageInput): Promise<MonthlyRecapPageResult>;
}

export function createMonthlyRecapActivities(store: MonthlyRecapStore): MonthlyRecapActivities {
  return { MonthlyJarRecapActivity: (input) => store.generatePage(input) };
}
