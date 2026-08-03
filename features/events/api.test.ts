import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";

import { EventSelectSchema } from "./api";
import type * as schema from "./schema";
import { createEvent, daysUntil, deleteEvent, listEvents, updateEvent } from "./service";

type Db = NodePgDatabase<typeof schema>;

// ─── daysUntil pure function ───────────────────────────────────────────────

describe("daysUntil", () => {
  // Helper: build a Date at midnight Pacific for a given date string.
  const la = (s: string) => new Date(`${s}T12:00:00-07:00`);

  it("returns 0 for today", () => {
    const now = la("2025-06-01");
    expect(daysUntil(la("2025-06-01"), now)).toBe(0);
  });

  it("returns a negative count for a past date", () => {
    const now = la("2025-06-10");
    expect(daysUntil(la("2025-06-01"), now)).toBe(-9);
  });

  it("returns -1 for yesterday", () => {
    const now = la("2025-06-02");
    expect(daysUntil(la("2025-06-01"), now)).toBe(-1);
  });

  it("returns 1 for tomorrow", () => {
    const now = la("2025-06-01");
    expect(daysUntil(la("2025-06-02"), now)).toBe(1);
  });

  it("returns 3 for three days ahead", () => {
    const now = la("2025-06-01");
    expect(daysUntil(la("2025-06-04"), now)).toBe(3);
  });

  it("returns 30 for thirty days ahead", () => {
    const now = la("2025-06-01");
    expect(daysUntil(la("2025-07-01"), now)).toBe(30);
  });

  it("handles day boundary: event at 11pm PT same calendar day → 0", () => {
    const now = new Date("2025-06-01T08:00:00-07:00"); // 8am PT
    const target = new Date("2025-06-01T23:00:00-07:00"); // 11pm PT same day
    expect(daysUntil(target, now)).toBe(0);
  });

  it("handles UTC date crossing Pacific midnight correctly", () => {
    // 2am UTC on June 2 = 7pm PT on June 1 → event is same day in LA → 0
    const now = new Date("2025-06-02T02:00:00Z"); // 7pm PT June 1
    const target = new Date("2025-06-02T06:00:00Z"); // 11pm PT June 1 still
    expect(daysUntil(target, now)).toBe(0);
  });

  it("uses the selected panel timezone rather than the server timezone", () => {
    const now = new Date("2025-06-02T02:00:00Z");
    const target = new Date("2025-06-02T06:00:00Z");
    expect(daysUntil(target, now, "America/New_York")).toBe(1);
  });

  it("does not drift across year boundaries", () => {
    const now = la("2025-12-31");
    expect(daysUntil(la("2026-01-01"), now)).toBe(1);
  });

  it("handles leap year Feb 28 → Mar 1", () => {
    const now = la("2024-02-28");
    expect(daysUntil(la("2024-03-01"), now)).toBe(2);
  });
});

// ─── router output schema ─────────────────────────────────────────────────

describe("EventSelectSchema", () => {
  it("accepts a negative days count so includePast rows can be returned", () => {
    const row = {
      id: 1,
      name: "Old Show",
      place: "Past Venue",
      date: "2025-06-01T19:00:00.000Z",
      days: -9,
    };
    expect(EventSelectSchema.parse(row)).toMatchObject({ days: -9 });
  });
});

// ─── listEvents with mocked DB ────────────────────────────────────────────

describe("listEvents", () => {
  const makeMockDb = (rows: { name: string; place: string; date: Date }[]) => {
    const orderByFn = { orderBy: () => Promise.resolve(rows) };
    const selectFromFn = { from: () => orderByFn };
    return { select: () => selectFromFn } as unknown as Db;
  };

  it("returns empty array when DB returns empty array", async () => {
    const db = makeMockDb([]);
    const result = await listEvents(db);
    expect(result).toEqual([]);
  });

  it("throws when DB throws", async () => {
    const db = {
      select: () => {
        throw new Error("connection refused");
      },
    } as unknown as Db;
    await expect(listEvents(db)).rejects.toThrow("connection refused");
  });

  it("maps DB rows to {name, place, days} sorted by provided order", async () => {
    const now = new Date("2025-06-01T12:00:00-07:00");
    const in3Days = new Date("2025-06-04T12:00:00-07:00");
    const in10Days = new Date("2025-06-11T12:00:00-07:00");

    const rows = [
      { id: 1, name: "Artist A", place: "Venue A", date: in3Days, createdAt: now },
      { id: 2, name: "Artist B", place: "Venue B", date: in10Days, createdAt: now },
    ];

    const db = makeMockDb(rows);
    const result = await listEvents(db, { now });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: "Artist A",
      place: "Venue A",
      days: 3,
      date: in3Days.toISOString(),
    });
    expect(result[1]).toMatchObject({
      name: "Artist B",
      place: "Venue B",
      days: 10,
      date: in10Days.toISOString(),
    });
  });

  it("drops past events by default so they cannot render as 'Today'", async () => {
    const now = new Date("2025-06-10T12:00:00-07:00");
    const pastDate = new Date("2025-06-01T12:00:00-07:00");
    const future = new Date("2025-06-12T12:00:00-07:00");

    const rows = [
      { id: 1, name: "Old Show", place: "Past Venue", date: pastDate, createdAt: now },
      { id: 2, name: "Next Show", place: "Venue", date: future, createdAt: now },
    ];

    const result = await listEvents(makeMockDb(rows), { now });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Next Show", days: 2 });
  });

  it("keeps an event happening today", async () => {
    const now = new Date("2025-06-10T08:00:00-07:00");
    const laterToday = new Date("2025-06-10T23:00:00-07:00");
    const rows = [{ id: 1, name: "Tonight", place: "Venue", date: laterToday, createdAt: now }];

    const result = await listEvents(makeMockDb(rows), { now });

    expect(result).toHaveLength(1);
    expect(result[0].days).toBe(0);
  });

  it("includes past events with negative days when includePast is set", async () => {
    const now = new Date("2025-06-10T12:00:00-07:00");
    const pastDate = new Date("2025-06-01T12:00:00-07:00");
    const rows = [{ id: 1, name: "Old Show", place: "Past Venue", date: pastDate, createdAt: now }];

    const result = await listEvents(makeMockDb(rows), { now, includePast: true });

    expect(result).toHaveLength(1);
    expect(result[0].days).toBe(-9);
  });

  it("surfaces the row id so the manage UI can target it", async () => {
    const now = new Date("2025-06-01T12:00:00-07:00");
    const rows = [{ id: 42, name: "Show", place: "Venue", date: now, createdAt: now }];
    const result = await listEvents(makeMockDb(rows), { now });
    expect(result[0].id).toBe(42);
  });
});

// ─── createEvent / updateEvent / deleteEvent with mocked DB ────────────────

describe("createEvent", () => {
  it("inserts the parsed date and returns the mapped row", async () => {
    const now = new Date("2026-06-12T12:00:00-07:00");
    const values = vi.fn().mockReturnValue({
      returning: () =>
        Promise.resolve([
          {
            id: 7,
            name: "SOSA",
            place: "Expo Park",
            date: new Date("2026-06-15T03:00:00Z"),
            createdAt: now,
          },
        ]),
    });
    const db = { insert: () => ({ values }) } as unknown as Db;

    const row = await createEvent(
      db,
      { name: "SOSA", place: "Expo Park", date: "2026-06-15T03:00:00Z" },
      now,
    );

    // The service parses the ISO string to a real Date before inserting.
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "SOSA",
        place: "Expo Park",
        date: new Date("2026-06-15T03:00:00Z"),
      }),
    );
    // 2026-06-15T03:00Z = Jun 14 8pm PT; from Jun 12 (now) that is 2 days.
    expect(row).toMatchObject({ id: 7, name: "SOSA", place: "Expo Park", days: 2 });
  });
});

describe("updateEvent", () => {
  it("updates by id and returns the mapped row", async () => {
    const now = new Date("2026-06-12T12:00:00-07:00");
    const db = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () =>
              Promise.resolve([
                {
                  id: 7,
                  name: "New",
                  place: "New Venue",
                  date: new Date("2026-06-14T03:00:00Z"),
                  createdAt: now,
                },
              ]),
          }),
        }),
      }),
    } as unknown as Db;

    const row = await updateEvent(
      db,
      7,
      { name: "New", place: "New Venue", date: "2026-06-14T03:00:00Z" },
      now,
    );
    // 2026-06-14T03:00Z = Jun 13 8pm PT; from Jun 12 (now) that is 1 day.
    expect(row).toMatchObject({ id: 7, name: "New", place: "New Venue", days: 1 });
  });

  it("throws when the id does not exist", async () => {
    const db = {
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
      }),
    } as unknown as Db;
    await expect(
      updateEvent(db, 999, { name: "x", place: "", date: "2026-06-14T03:00:00Z" }),
    ).rejects.toThrow("event 999 not found");
  });
});

describe("deleteEvent", () => {
  it("deletes by id and returns the id", async () => {
    const db = {
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 7 }]) }) }),
    } as unknown as Db;
    expect(await deleteEvent(db, 7)).toEqual({ id: 7 });
  });

  it("throws when the id does not exist", async () => {
    const db = {
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Db;
    await expect(deleteEvent(db, 999)).rejects.toThrow("event 999 not found");
  });
});
