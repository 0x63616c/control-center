import { type JarRecapDTO, JarRecapSchema, type RecapId, type UserId } from "../../../contracts";
import { pool } from "./db/index";

type RecapRow = Readonly<{
  id: string;
  jar_id: string;
  jar_name: string;
  calendar_month: string;
  timezone: string;
  period_start_at: string;
  period_end_at: string;
  slip_count: number;
  total_amount_cents: string;
  tally_change_cents: string;
  shared_streak_highlights: unknown;
  crossed_milestones_cents: unknown;
  created_at: string;
}>;

function parseRecap(row: RecapRow): JarRecapDTO {
  return JarRecapSchema.parse({
    id: row.id,
    jarId: row.jar_id,
    jarName: row.jar_name,
    calendarMonth: row.calendar_month,
    timezone: row.timezone,
    periodStartAt: Number(row.period_start_at),
    periodEndAt: Number(row.period_end_at),
    slipCount: row.slip_count,
    totalAmountCents: Number(row.total_amount_cents),
    tallyChangeCents: Number(row.tally_change_cents),
    sharedStreakHighlights: row.shared_streak_highlights,
    crossedMilestonesCents: row.crossed_milestones_cents,
    createdAt: Number(row.created_at),
  });
}

export async function listRecaps(userId: UserId): Promise<readonly JarRecapDTO[]> {
  const result = await pool.query<RecapRow>(
    `SELECT r.id,r.jar_id,j.name AS jar_name,r.calendar_month,r.timezone,
       r.period_start_at::text,r.period_end_at::text,r.slip_count,
       r.total_amount_cents::text,r.tally_change_cents::text,
       r.shared_streak_highlights,r.crossed_milestones_cents,r.created_at::text
     FROM jar_recaps r
     JOIN jars j ON j.id=r.jar_id
     JOIN jar_recap_recipients rr ON rr.recap_id=r.id
     JOIN memberships m ON m.jar_id=r.jar_id AND m.user_id=rr.user_id AND m.left_at IS NULL
     WHERE rr.user_id=$1
     ORDER BY r.calendar_month DESC,r.jar_id`,
    [userId],
  );
  return result.rows.map(parseRecap);
}

export async function getRecap(userId: UserId, recapId: RecapId): Promise<JarRecapDTO | null> {
  const result = await pool.query<RecapRow>(
    `SELECT r.id,r.jar_id,j.name AS jar_name,r.calendar_month,r.timezone,
       r.period_start_at::text,r.period_end_at::text,r.slip_count,
       r.total_amount_cents::text,r.tally_change_cents::text,
       r.shared_streak_highlights,r.crossed_milestones_cents,r.created_at::text
     FROM jar_recaps r
     JOIN jars j ON j.id=r.jar_id
     JOIN jar_recap_recipients rr ON rr.recap_id=r.id
     JOIN memberships m ON m.jar_id=r.jar_id AND m.user_id=rr.user_id AND m.left_at IS NULL
     WHERE rr.user_id=$1 AND r.id=$2`,
    [userId, recapId],
  );
  return result.rows[0] ? parseRecap(result.rows[0]) : null;
}
