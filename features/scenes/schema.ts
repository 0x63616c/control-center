import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const scene = pgTable(
  "scene",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon").notNull(),
    actions: jsonb("actions").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("scene_updated_at_idx").on(table.updatedAt)],
);

export const sceneRun = pgTable(
  "scene_run",
  {
    id: text("id").primaryKey(),
    sceneId: text("scene_id").references(() => scene.id, { onDelete: "set null" }),
    sceneName: text("scene_name").notNull(),
    status: text("status").notNull(),
    resolved: jsonb("resolved").$type<unknown>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [index("scene_run_started_at_idx").on(table.startedAt)],
);
