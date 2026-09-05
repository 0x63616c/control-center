import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { CourseConfig, Settings } from "./model";

export const injectionCourse = pgTable("injection_course", {
  id: text("id").primaryKey(),
  config: jsonb("config").$type<CourseConfig>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const injectionVial = pgTable(
  "injection_vial",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => injectionCourse.id),
    label: text("label").notNull(),
    volume: doublePrecision("volume_ml").notNull(),
    concentration: doublePrecision("concentration_mg_ml").notNull(),
    syringeScale: doublePrecision("syringe_units_ml").notNull(),
    receivedDate: text("received_date"),
    openedDate: text("opened_date"),
    discardDate: text("discard_date"),
    retired: boolean("retired").notNull().default(false),
  },
  (t) => [index("injection_vial_course_idx").on(t.courseId)],
);
export const actualInjection = pgTable(
  "actual_injection",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => injectionCourse.id),
    vialId: text("vial_id")
      .notNull()
      .references(() => injectionVial.id),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull(),
    units: doublePrecision("units").notNull(),
    plannedAt: timestamp("planned_at", { withTimezone: true, mode: "string" }),
    notes: text("notes").notNull().default(""),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("actual_injection_course_at_idx").on(t.courseId, t.at),
    index("actual_injection_vial_idx").on(t.vialId),
  ],
);
export const injectionCheckIn = pgTable(
  "injection_check_in",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => injectionCourse.id),
    date: text("date").notNull(),
    values: jsonb("values").$type<Record<string, number>>().notNull(),
    notes: text("notes").notNull().default(""),
    weightId: text("weight_id"),
  },
  (t) => [uniqueIndex("injection_check_in_day_idx").on(t.courseId, t.date)],
);
export const injectionPhoto = pgTable(
  "injection_photo",
  {
    id: text("id").primaryKey(),
    courseId: text("course_id")
      .notNull()
      .references(() => injectionCourse.id),
    at: timestamp("at", { withTimezone: true, mode: "string" }).notNull(),
    pose: text("pose").$type<"front" | "side" | "back" | "custom">().notNull(),
    notes: text("notes").notNull().default(""),
    weightId: text("weight_id"),
    reference: boolean("reference").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("injection_photo_course_at_idx").on(t.courseId, t.at)],
);
export const injectionSettings = pgTable("injection_settings", {
  id: text("id").primaryKey(),
  config: jsonb("config").$type<Settings>().notNull(),
});
