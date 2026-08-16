import type { Pool, PoolClient } from "pg";
import { NotificationIdSchema } from "../../../contracts";
import { StreakAchievementIdSchema } from "../../api/src/domain-events";
import type {
  DomainTransactionContext,
  DomainTransactionRunner,
} from "../../api/src/domain-transaction";
import { id } from "../../api/src/ids";

const STREAK_MILESTONES = [7, 30, 100, 365] as const;
export type StreakMilestoneDays = (typeof STREAK_MILESTONES)[number];
export type LocalDate = string & { readonly __brand: "LocalDate" };

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseLocalDate(value: string): LocalDate {
  if (!LOCAL_DATE_PATTERN.test(value)) throw new Error("invalid local date");
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new Error("invalid local date");
  }
  return value as LocalDate;
}

function localDateEpochDay(value: LocalDate): number {
  return Date.parse(`${parseLocalDate(value)}T00:00:00.000Z`) / 86_400_000;
}

function addLocalDays(value: LocalDate, days: number): LocalDate {
  return parseLocalDate(
    new Date((localDateEpochDay(value) + days) * 86_400_000).toISOString().slice(0, 10),
  );
}

export function dueMilestones(
  currentLocalDate: LocalDate,
  streakStartedLocalDate: LocalDate,
): readonly { readonly days: StreakMilestoneDays; readonly reachedLocalDate: LocalDate }[] {
  const elapsedDays =
    localDateEpochDay(currentLocalDate) - localDateEpochDay(streakStartedLocalDate);
  return STREAK_MILESTONES.filter((days) => days <= elapsedDays).map((days) => ({
    days,
    reachedLocalDate: addLocalDays(streakStartedLocalDate, days),
  }));
}

export interface StreakSweepPageInput {
  readonly cutoff: number;
  readonly cursor?: string;
  readonly limit: number;
}

export interface StreakSweepPageResult {
  readonly candidates: number;
  readonly achievements: number;
  readonly notifications: number;
  readonly sharedActivities: number;
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

export interface StreakSweepStore {
  processPage(input: StreakSweepPageInput): Promise<StreakSweepPageResult>;
}

type CandidateRow = Readonly<{
  membership_id: string;
  user_id: string;
  jar_id: string;
  streak_start_at: string;
  share_streak: boolean;
  notifications_enabled: boolean;
  local_date: string;
  streak_local_date: string;
}>;

export class PostgresStreakSweepStore implements StreakSweepStore {
  constructor(private readonly transactions: Pick<DomainTransactionRunner, "run">) {}

  async processPage(input: StreakSweepPageInput): Promise<StreakSweepPageResult> {
    if (!Number.isSafeInteger(input.cutoff) || input.cutoff < 0)
      throw new Error("invalid streak sweep cutoff");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new Error("streak sweep limit must be between 1 and 500");
    }
    return this.transactions.run((context) => this.#processPage(context, input));
  }

  async #processPage(
    { db, emit }: DomainTransactionContext,
    input: StreakSweepPageInput,
  ): Promise<StreakSweepPageResult> {
    const result = await db.query<CandidateRow>(
      `SELECT m.id AS membership_id,m.user_id,m.jar_id,m.streak_start_at::text,
              (m.share_streak <> 0) AS share_streak,
              COALESCE(pref.enabled,FALSE) AS notifications_enabled,
              ((to_timestamp($1 / 1000.0) AT TIME ZONE u.timezone)::date)::text AS local_date,
              ((to_timestamp(m.streak_start_at / 1000.0) AT TIME ZONE u.timezone)::date)::text
                AS streak_local_date
       FROM memberships m
       JOIN users u ON u.id=m.user_id
       JOIN jars j ON j.id=m.jar_id
       LEFT JOIN notification_preference pref
         ON pref.user_id=m.user_id AND pref.category='streak_milestone'
       WHERE m.left_at IS NULL AND j.closed_at IS NULL AND m.streak_start_at IS NOT NULL
         AND m.joined_at <= $1 AND m.streak_start_at <= $1
         AND m.id > $2
         AND (to_timestamp($1 / 1000.0) AT TIME ZONE u.timezone)::time >= TIME '09:00'
       ORDER BY m.id
       FOR UPDATE OF m
       LIMIT $3`,
      [input.cutoff, input.cursor ?? "", input.limit + 1],
    );
    const candidates = result.rows.slice(0, input.limit);
    let achievements = 0;
    let notifications = 0;
    let sharedActivities = 0;
    for (const candidate of candidates) {
      for (const milestone of dueMilestones(
        parseLocalDate(candidate.local_date),
        parseLocalDate(candidate.streak_local_date),
      )) {
        const achievementId = StreakAchievementIdSchema.parse(id("sta"));
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO streak_achievements
             (id,membership_id,streak_started_at,milestone_days,reached_local_date,created_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            achievementId,
            candidate.membership_id,
            Number(candidate.streak_start_at),
            milestone.days,
            milestone.reachedLocalDate,
            input.cutoff,
          ],
        );
        if (!inserted.rows[0]) continue;
        achievements += 1;
        await emit({
          type: "streak.milestone_reached",
          aggregateId: achievementId,
          aggregateVersion: 1,
        });
        if (candidate.share_streak) {
          await this.#insertSharedActivity(db, candidate, milestone.days, input.cutoff);
          sharedActivities += 1;
        }
        if (candidate.notifications_enabled) {
          const notificationId = NotificationIdSchema.parse(id("ntf"));
          await db.query(
            `INSERT INTO user_notification
               (id,recipient_user_id,category,dedupe_key,target_type,target_id,message_key,created_at)
             VALUES ($1,$2,'streak_milestone',$3,'profile',$4,'streak.milestone',$5)`,
            [
              notificationId,
              candidate.user_id,
              `streak-milestone:${achievementId}`,
              achievementId,
              input.cutoff,
            ],
          );
          await emit({
            type: "notification.requested",
            aggregateId: notificationId,
            aggregateVersion: 1,
          });
          notifications += 1;
        }
      }
    }
    const finalCandidate = candidates.at(-1);
    return {
      candidates: candidates.length,
      achievements,
      notifications,
      sharedActivities,
      ...(finalCandidate ? { nextCursor: finalCandidate.membership_id } : {}),
      hasMore: result.rows.length > input.limit,
    };
  }

  async #insertSharedActivity(
    db: Pick<Pool | PoolClient, "query">,
    candidate: CandidateRow,
    milestoneDays: StreakMilestoneDays,
    createdAt: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO activity
         (id,jar_id,actor_id,target_id,type,text,created_at)
       VALUES ($1,$2,$3,$3,'milestone',$4,$5)`,
      [
        id("act"),
        candidate.jar_id,
        candidate.user_id,
        `Reached a ${milestoneDays}-day clean streak.`,
        createdAt,
      ],
    );
  }
}

export interface StreakMilestoneActivities {
  StreakMilestoneSweepActivity(input: StreakSweepPageInput): Promise<StreakSweepPageResult>;
}

export function createStreakMilestoneActivities(
  store: StreakSweepStore,
): StreakMilestoneActivities {
  return { StreakMilestoneSweepActivity: (input) => store.processPage(input) };
}
