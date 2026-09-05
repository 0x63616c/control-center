import { z } from "zod";

export const DAY = 86_400_000;
export const LB_PER_KG = 2.2046226218;
export const UNITS = ["units", "mg", "mL"] as const;
export const RANGES = ["4W", "12W", "Course", "All"] as const;
export const POSES = ["front", "side", "back", "custom"] as const;
export const dateInput = z.iso.date();
export const timeInput = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const positive = z.number().finite().positive().max(10000);
export const stageInput = z
  .object({
    startWeek: z.number().int().min(1).max(520),
    endWeek: z.number().int().min(1).max(520),
    units: positive,
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    time: timeInput,
  })
  .refine((s) => s.endWeek >= s.startWeek, "Stage ends before it starts");
export const settingsInput = z.object({
  medication: z.string().trim().min(1).max(100),
  concentration: positive,
  syringeScale: positive,
  vialVolume: positive,
  halfLifeDays: positive.nullable(),
  primaryUnit: z.enum(UNITS),
  range: z.enum(RANGES),
  checkInFields: z.array(z.string().trim().min(1).max(40)).max(20),
  stages: z.array(stageInput).min(1).max(30),
});
export const courseInput = settingsInput
  .extend({
    name: z.string().trim().min(1).max(120),
    startDate: dateInput,
    endDate: dateInput.nullable(),
    timezone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "Use an IANA time zone"),
    status: z.enum(["active", "completed", "scenario"]),
    notes: z.string().max(10000),
  })
  .superRefine((c, ctx) => {
    if (c.endDate && c.endDate < c.startDate)
      ctx.addIssue({ code: "custom", message: "Course ends before it starts" });
    for (let i = 0; i < c.stages.length; i++)
      for (let j = i + 1; j < c.stages.length; j++) {
        const a = c.stages[i],
          b = c.stages[j];
        if (
          a &&
          b &&
          a.startWeek <= b.endWeek &&
          b.startWeek <= a.endWeek &&
          a.time === b.time &&
          a.weekdays.some((d) => b.weekdays.includes(d))
        )
          ctx.addIssue({
            code: "custom",
            message: "Schedule stages overlap on the same day and time",
          });
      }
  });
export type Settings = z.infer<typeof settingsInput>;
export type CourseConfig = z.infer<typeof courseInput>;
export type Course = CourseConfig & { id: string };
export type Vial = {
  id: string;
  courseId: string;
  label: string;
  volume: number;
  concentration: number;
  syringeScale: number;
  receivedDate: string | null;
  openedDate: string | null;
  discardDate: string | null;
  retired: boolean;
};
export type Injection = {
  id: string;
  courseId: string;
  vialId: string;
  at: string;
  units: number;
  notes: string;
  plannedAt: string | null;
};
export type CheckIn = {
  id: string;
  courseId: string;
  date: string;
  values: Record<string, number>;
  notes: string;
  weightId: string | null;
};
export type Photo = {
  id: string;
  courseId: string;
  at: string;
  pose: (typeof POSES)[number];
  notes: string;
  weightId: string | null;
  reference: boolean;
};
export type Weight = { id: string; at: string; kg: number };
export type RecordSet = {
  course: Course;
  vials: Vial[];
  injections: Injection[];
  checkIns: CheckIn[];
  photos: Photo[];
};
export const DEFAULTS: Settings = {
  medication: "Semaglutide",
  concentration: 5,
  syringeScale: 100,
  vialVolume: 2,
  halfLifeDays: 7,
  primaryUnit: "units",
  range: "12W",
  checkInFields: ["Appetite", "Energy", "Nausea"],
  stages: [
    { startWeek: 1, endWeek: 4, units: 3, weekdays: [5], time: "20:00" },
    { startWeek: 5, endWeek: 12, units: 8, weekdays: [5], time: "20:00" },
  ],
};
export function convert(units: number, vial: Pick<Vial, "syringeScale" | "concentration">) {
  const ml = units / vial.syringeScale;
  return { units, ml, mg: ml * vial.concentration };
}
export function dayAt(at: string | number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
export function dayNumber(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) / DAY;
}
// Resolve wall-clock recurrence in the course's zone, preserving local time across DST.
export function zonedTime(day: string, time: string, timezone: string): number {
  const target = Date.parse(`${day}T${time}:00Z`);
  let at = target;
  for (let n = 0; n < 4; n++) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    const wall = Date.parse(
      `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`,
    );
    const delta = target - wall;
    if (delta === 0) break;
    at += delta;
  }
  return at;
}
export type Planned = { at: string; units: number; mg: number; ml: number; week: number };
export function plannedInjections(course: CourseConfig): Planned[] {
  const result: Planned[] = [];
  for (const stage of course.stages)
    for (let d = (stage.startWeek - 1) * 7; d < stage.endWeek * 7; d++) {
      const day = addDays(course.startDate, d);
      if (course.endDate && day > course.endDate) continue;
      if (!stage.weekdays.includes(new Date(`${day}T12:00:00Z`).getUTCDay())) continue;
      result.push({
        at: new Date(zonedTime(day, stage.time, course.timezone)).toISOString(),
        ...convert(stage.units, course),
        week: Math.floor(d / 7) + 1,
      });
    }
  return result.sort((a, b) => a.at.localeCompare(b.at));
}
export function doses(data: RecordSet) {
  return data.injections
    .flatMap((i) => {
      const v = data.vials.find((v) => v.id === i.vialId);
      return v ? [{ ...i, ...convert(i.units, v) }] : [];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}
export function remaining(
  doseEvents: readonly { at: string; mg: number }[],
  at: number,
  halfLifeDays: number | null,
): number | null {
  if (halfLifeDays === null) return null;
  return doseEvents.reduce((sum, i) => {
    const age = at - Date.parse(i.at);
    return sum + (age < 0 ? 0 : i.mg * 0.5 ** (age / (halfLifeDays * DAY)));
  }, 0);
}
export function usedVolume(vial: Vial, injections: readonly Injection[], at = Infinity): number {
  return injections.reduce(
    (sum, i) =>
      sum + (i.vialId === vial.id && Date.parse(i.at) <= at ? i.units / vial.syringeScale : 0),
    0,
  );
}
export function courseWeek(course: CourseConfig, at: number): number {
  return Math.floor((dayNumber(dayAt(at, course.timezone)) - dayNumber(course.startDate)) / 7) + 1;
}
export function weightStats(weights: readonly Weight[], course: CourseConfig, until = Date.now()) {
  const rows = weights
    .filter(
      (w) =>
        dayAt(w.at, course.timezone) >= course.startDate &&
        (!course.endDate || dayAt(w.at, course.timezone) <= course.endDate) &&
        Date.parse(w.at) <= until,
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  const first = rows[0],
    last = rows.at(-1);
  if (!first || !last) return null;
  const change = last.kg - first.kg,
    weeks = (Date.parse(last.at) - Date.parse(first.at)) / (7 * DAY);
  return {
    first,
    last,
    change,
    percent: (change / first.kg) * 100,
    weekly: weeks >= 1 ? change / weeks : null,
    low: Math.min(...rows.map((w) => w.kg)),
    rows,
  };
}
export function scenario(
  preset: "2024" | "2026",
  startDate: string,
  timezone: string,
): CourseConfig {
  return {
    ...DEFAULTS,
    name: `${preset} prescribed scenario`,
    status: "scenario",
    startDate,
    endDate: null,
    timezone,
    notes: "Modeled schedule only. No actual injections or historical weight inferred.",
    stages:
      preset === "2024"
        ? [
            { startWeek: 1, endWeek: 4, units: 5, weekdays: [5], time: "20:00" },
            { startWeek: 5, endWeek: 8, units: 10, weekdays: [5], time: "20:00" },
            { startWeek: 9, endWeek: 12, units: 20, weekdays: [5], time: "20:00" },
          ]
        : DEFAULTS.stages,
  };
}
