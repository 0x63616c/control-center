import { genId } from "@www/platform";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { db } from "./db";
import { goal, goalCheckin, goalSchedule, goalVacation } from "./schema";
import { goalDayAt, mondayOf, shiftGoalDay, weekdayOf } from "./time";

type Database = typeof db;
type GoalKind = "simple" | "measured" | "reflective";
export type ScheduleInput =
  | { kind: "daily" }
  | { kind: "weekdays"; weekdays: number[] }
  | { kind: "weekly"; weeklyTarget: number };

export type GoalInput = {
  title: string;
  encouragement?: string | null;
  kind: GoalKind;
  target?: number | null;
  reflectivePrompts?: string[] | null;
  schedule: ScheduleInput;
  effectiveFrom: string;
};

function scheduleValues(input: ScheduleInput) {
  return {
    kind: input.kind,
    weekdays: input.kind === "weekdays" ? [...new Set(input.weekdays)].sort() : null,
    weeklyTarget: input.kind === "weekly" ? input.weeklyTarget : null,
  };
}

export async function createGoal(database: Database, input: GoalInput) {
  const now = new Date();
  const id = genId("goal");
  await database.insert(goal).values({
    id,
    title: input.title,
    encouragement: input.encouragement ?? null,
    kind: input.kind,
    target: input.target ?? null,
    reflectivePrompts: input.reflectivePrompts ?? null,
    createdAt: now,
    updatedAt: now,
  });
  await database.insert(goalSchedule).values({
    id: genId("goal_schedule"),
    goalId: id,
    effectiveFrom: input.effectiveFrom,
    ...scheduleValues(input.schedule),
    createdAt: now,
  });
  return id;
}

export async function updateGoal(
  database: Database,
  id: string,
  input: Omit<GoalInput, "effectiveFrom"> & { effectiveFrom: string },
) {
  const now = new Date();
  await database
    .update(goal)
    .set({
      title: input.title,
      encouragement: input.encouragement ?? null,
      kind: input.kind,
      target: input.target ?? null,
      reflectivePrompts: input.reflectivePrompts ?? null,
      updatedAt: now,
    })
    .where(eq(goal.id, id));
  await database
    .insert(goalSchedule)
    .values({
      id: genId("goal_schedule"),
      goalId: id,
      effectiveFrom: input.effectiveFrom,
      ...scheduleValues(input.schedule),
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [goalSchedule.goalId, goalSchedule.effectiveFrom],
      set: { ...scheduleValues(input.schedule) },
    });
}

export async function setGoalStatus(
  database: Database,
  id: string,
  status: "active" | "paused" | "archived",
) {
  await database.update(goal).set({ status, updatedAt: new Date() }).where(eq(goal.id, id));
}

export async function saveCheckin(
  database: Database,
  input: {
    goalId: string;
    day: string;
    state: "complete" | "partial" | "not_today";
    value?: number | null;
    reflection?: string | null;
  },
) {
  const now = new Date();
  await database
    .insert(goalCheckin)
    .values({
      id: genId("goal_checkin"),
      ...input,
      value: input.value ?? null,
      reflection: input.reflection ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [goalCheckin.goalId, goalCheckin.day],
      set: {
        state: input.state,
        value: input.value ?? null,
        reflection: input.reflection ?? null,
        updatedAt: now,
      },
    });
}

export async function addVacation(database: Database, startDay: string, endDay: string) {
  await database.insert(goalVacation).values({ id: genId("goal_vacation"), startDay, endDay });
}

export async function deleteVacation(database: Database, id: string) {
  await database.delete(goalVacation).where(eq(goalVacation.id, id));
}

function isVacation(day: string, vacations: { startDay: string; endDay: string }[]): boolean {
  return vacations.some((vacation) => vacation.startDay <= day && day <= vacation.endDay);
}

function scheduleFor(day: string, schedules: (typeof goalSchedule.$inferSelect)[]) {
  return schedules.filter((schedule) => schedule.effectiveFrom <= day).at(-1) ?? null;
}

function scheduledOn(day: string, schedule: typeof goalSchedule.$inferSelect | null): boolean {
  if (!schedule) return false;
  if (schedule.kind === "daily") return true;
  if (schedule.kind === "weekdays") return schedule.weekdays?.includes(weekdayOf(day)) ?? false;
  // Flexible weekly goals deliberately do not turn unchosen dates into misses.
  return false;
}

function complete(
  checkin: typeof goalCheckin.$inferSelect | undefined,
  item: typeof goal.$inferSelect,
): boolean {
  if (checkin?.state !== "complete") return false;
  return item.kind !== "measured" || (checkin.value ?? 0) >= (item.target ?? 1);
}

function streakFor(
  item: typeof goal.$inferSelect,
  days: string[],
  schedules: (typeof goalSchedule.$inferSelect)[],
  checkins: Map<string, typeof goalCheckin.$inferSelect>,
  vacations: { startDay: string; endDay: string }[],
): { count: number; unit: "day" | "week" } {
  const latest = schedules.at(-1);
  if (latest?.kind === "weekly") {
    let count = 0;
    for (let cursor = mondayOf(days.at(-1) ?? ""); ; cursor = shiftGoalDay(cursor, -7)) {
      const weekDays = Array.from({ length: 7 }, (_, index) => shiftGoalDay(cursor, index));
      if (weekDays.every((day) => day > (days.at(-1) ?? ""))) continue;
      const done = weekDays.filter((day) => complete(checkins.get(day), item)).length;
      if (done < (latest.weeklyTarget ?? 1) && !weekDays.every((day) => isVacation(day, vacations)))
        break;
      count += 1;
      if (count >= 52) break;
    }
    return { count, unit: "week" };
  }
  let count = 0;
  for (const day of [...days].reverse()) {
    if (isVacation(day, vacations)) continue;
    if (!scheduledOn(day, scheduleFor(day, schedules))) continue;
    if (!complete(checkins.get(day), item)) break;
    count += 1;
  }
  return { count, unit: "day" };
}

/** The derived dashboard seam shared by the tile, Today and History. */
export async function dashboard(
  database: Database,
  options: {
    now: Date;
    timeZone: string;
    cutoffHour: number;
    endDay?: string;
    days?: number;
    includeArchived?: boolean;
  },
) {
  const endDay = options.endDay ?? goalDayAt(options.now, options.timeZone, options.cutoffHour);
  const count = options.days ?? 7;
  const startDay = shiftGoalDay(endDay, 1 - count);
  const days = Array.from({ length: count }, (_, index) => shiftGoalDay(startDay, index));
  // A seven-day strip is enough to render, but a meaningful streak needs more
  // history. Keep this bounded so the dashboard remains a single predictable query.
  const streakStartDay = shiftGoalDay(endDay, -365);
  const streakDays = Array.from({ length: 366 }, (_, index) => shiftGoalDay(streakStartDay, index));
  const goals = await database
    .select()
    .from(goal)
    .where(options.includeArchived ? undefined : eq(goal.status, "active"))
    .orderBy(asc(goal.createdAt));
  const ids = goals.map((item) => item.id);
  const [schedules, checkins, vacations] = await Promise.all([
    ids.length
      ? database
          .select()
          .from(goalSchedule)
          .where(inArray(goalSchedule.goalId, ids))
          .orderBy(asc(goalSchedule.effectiveFrom))
      : [],
    ids.length
      ? database
          .select()
          .from(goalCheckin)
          .where(
            and(
              inArray(goalCheckin.goalId, ids),
              gte(goalCheckin.day, streakStartDay),
              lte(goalCheckin.day, endDay),
            ),
          )
      : [],
    database
      .select()
      .from(goalVacation)
      .where(and(lte(goalVacation.startDay, endDay), gte(goalVacation.endDay, streakStartDay)))
      .orderBy(desc(goalVacation.startDay)),
  ]);
  const schedulesByGoal = new Map<string, typeof schedules>();
  for (const schedule of schedules)
    schedulesByGoal.set(schedule.goalId, [
      ...(schedulesByGoal.get(schedule.goalId) ?? []),
      schedule,
    ]);
  const checkinsByGoal = new Map<string, Map<string, (typeof checkins)[number]>>();
  for (const checkin of checkins) {
    const byDay = checkinsByGoal.get(checkin.goalId) ?? new Map();
    byDay.set(checkin.day, checkin);
    checkinsByGoal.set(checkin.goalId, byDay);
  }
  return {
    endDay,
    days,
    vacations,
    goals: goals.map((item) => {
      const itemSchedules = schedulesByGoal.get(item.id) ?? [];
      const itemCheckins = checkinsByGoal.get(item.id) ?? new Map();
      const todaySchedule = scheduleFor(endDay, itemSchedules);
      const weekStart = mondayOf(endDay);
      const weekDays = Array.from({ length: 7 }, (_, index) => shiftGoalDay(weekStart, index));
      const weeklyDone = weekDays.filter((day) => complete(itemCheckins.get(day), item)).length;
      return {
        ...item,
        schedule: todaySchedule,
        weeklyDone,
        weekTarget: todaySchedule?.kind === "weekly" ? todaySchedule.weeklyTarget : null,
        streak: streakFor(item, streakDays, itemSchedules, itemCheckins, vacations),
        days: days.map((day) => {
          const checkin = itemCheckins.get(day);
          return {
            day,
            checkin: checkin ?? null,
            vacation: isVacation(day, vacations),
            scheduled: scheduledOn(day, scheduleFor(day, itemSchedules)),
            complete: complete(checkin, item),
          };
        }),
      };
    }),
  };
}
