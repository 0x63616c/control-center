import { DEFAULT_TIME_ZONE } from "@cc/api/settings";
import { asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

export interface EventRow {
  /** DB primary key, needed so the manage UI can target edit/delete. */
  id: number;
  name: string;
  place: string;
  days: number;
  /** ISO-8601 date string from the DB timestamptz, e.g. "2026-06-14T19:00:00-07:00". */
  date: string;
}

/** Fields a client may write when creating/updating an event. */
export interface EventInput {
  name: string;
  /** Optional location/venue; stored in the `place` column. Empty string when unset. */
  place: string;
  /** Event moment as an ISO-8601 string (client sends ISO, DB stores timestamptz). */
  date: string;
}

/**
 * Pure helper: whole days from now until `target` in the panel's chosen zone.
 * Negative for past events, 0 for today. Callers rely on the sign to tell a
 * stale event apart from one happening today.
 */
export function daysUntil(
  target: Date,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): number {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  const parse = (s: string) => {
    const [m, d, y] = s.split("/").map(Number);
    return new Date(y, m - 1, d);
  };

  const todayLocal = parse(fmt(now));
  const targetLocal = parse(fmt(target));

  const diff = targetLocal.getTime() - todayLocal.getTime();
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

/** Map a raw DB row to the API row shape (adds computed `days`, serializes date). */
function toEventRow(r: typeof schema.events.$inferSelect, now: Date, timeZone: string): EventRow {
  return {
    id: r.id,
    name: r.name,
    place: r.place,
    days: daysUntil(r.date, now, timeZone),
    date: r.date.toISOString(),
  };
}

export interface ListEventsOptions {
  /** Reference moment; injectable for tests. */
  now?: Date;
  /** IANA timezone that defines the panel's calendar days. */
  timeZone?: string;
  /**
   * Include events whose date has already passed. Off by default: the board
   * tile and the read modals only ever want what's still ahead. The manage
   * surface turns it on so stale rows stay editable/deletable.
   */
  includePast?: boolean;
}

export async function listEvents(
  db: NodePgDatabase<typeof schema>,
  { now = new Date(), timeZone = DEFAULT_TIME_ZONE, includePast = false }: ListEventsOptions = {},
): Promise<EventRow[]> {
  const rows = await db.select().from(schema.events).orderBy(asc(schema.events.date));
  const mapped = rows.map((r) => toEventRow(r, now, timeZone));
  return includePast ? mapped : mapped.filter((r) => r.days >= 0);
}

export async function createEvent(
  db: NodePgDatabase<typeof schema>,
  input: EventInput,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): Promise<EventRow> {
  const [row] = await db
    .insert(schema.events)
    .values({ name: input.name, place: input.place, date: new Date(input.date) })
    .returning();
  return toEventRow(row, now, timeZone);
}

export async function updateEvent(
  db: NodePgDatabase<typeof schema>,
  id: number,
  input: EventInput,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
): Promise<EventRow> {
  const [row] = await db
    .update(schema.events)
    .set({ name: input.name, place: input.place, date: new Date(input.date) })
    .where(eq(schema.events.id, id))
    .returning();
  if (!row) throw new Error(`event ${id} not found`);
  return toEventRow(row, now, timeZone);
}

export async function deleteEvent(
  db: NodePgDatabase<typeof schema>,
  id: number,
): Promise<{ id: number }> {
  const [row] = await db
    .delete(schema.events)
    .where(eq(schema.events.id, id))
    .returning({ id: schema.events.id });
  if (!row) throw new Error(`event ${id} not found`);
  return { id: row.id };
}
