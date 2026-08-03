import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** One personal intention. Its schedule is revisioned separately so history stays truthful. */
export const goal = pgTable(
  "goal",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    encouragement: text("encouragement"),
    kind: text("kind").$type<"simple" | "measured" | "reflective">().notNull(),
    target: integer("target"),
    reflectivePrompts: jsonb("reflective_prompts").$type<string[]>(),
    status: text("status").$type<"active" | "paused" | "archived">().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("goal_status_idx").on(table.status)],
);

/** A schedule revision takes effect on a goal-day, never retroactively mutating prior expectations. */
export const goalSchedule = pgTable(
  "goal_schedule",
  {
    id: text("id").primaryKey(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goal.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    kind: text("kind").$type<"daily" | "weekdays" | "weekly">().notNull(),
    weekdays: jsonb("weekdays").$type<number[]>(),
    weeklyTarget: integer("weekly_target"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("goal_schedule_goal_effective_unique").on(table.goalId, table.effectiveFrom),
    index("goal_schedule_goal_effective_idx").on(table.goalId, table.effectiveFrom),
  ],
);

/** A direct answer for a particular local goal-day. A date key remains stable if settings later change. */
export const goalCheckin = pgTable(
  "goal_checkin",
  {
    id: text("id").primaryKey(),
    goalId: text("goal_id")
      .notNull()
      .references(() => goal.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    state: text("state").$type<"complete" | "partial" | "not_today">().notNull(),
    value: integer("value"),
    reflection: text("reflection"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("goal_checkin_goal_day_unique").on(table.goalId, table.day),
    index("goal_checkin_day_idx").on(table.day),
  ],
);

/** Intentional rest pauses expectations globally while retaining visible real check-ins. */
export const goalVacation = pgTable(
  "goal_vacation",
  {
    id: text("id").primaryKey(),
    startDay: date("start_day", { mode: "string" }).notNull(),
    endDay: date("end_day", { mode: "string" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("goal_vacation_days_idx").on(table.startDay, table.endDay)],
);
