import { describe, expect, it } from "vitest";
import {
  convert,
  courseInput,
  DAY,
  DEFAULTS,
  plannedInjections,
  projectedDoses,
  type RecordSet,
  remaining,
  scenario,
  usedVolume,
  zonedTime,
} from "./model";

describe("injection accounting", () => {
  it("reproduces both supplied 12-week scenarios without inventing actual injections", () => {
    for (const [preset, units, ml, mg] of [
      ["2024", 140, 1.4, 7],
      ["2026", 76, 0.76, 3.8],
    ] as const) {
      const c = scenario(preset, "2026-09-04", "America/Los_Angeles"),
        p = plannedInjections(c);
      expect(p).toHaveLength(12);
      expect(p.reduce((s, i) => s + i.units, 0)).toBe(units);
      expect(p.reduce((s, i) => s + i.ml, 0)).toBeCloseTo(ml);
      expect(p.reduce((s, i) => s + i.mg, 0)).toBeCloseTo(mg);
    }
    expect(convert(3, DEFAULTS)).toEqual({ units: 3, ml: 0.03, mg: 0.15 });
    expect(convert(8, { syringeScale: 40, concentration: 2 })).toEqual({
      units: 8,
      ml: 0.2,
      mg: 0.4,
    });
  });
  it("decays each timestamped injection, excluding future doses", () => {
    const start = Date.parse("2026-09-01T00:00:00Z");
    const events = [
      { at: new Date(start).toISOString(), mg: 0.2 },
      { at: new Date(start + 3 * DAY).toISOString(), mg: 0.2 },
    ];
    expect(remaining(events, start, 7)).toBeCloseTo(0.2);
    expect(remaining(events, start + 3 * DAY - 1, 7)).toBeLessThan(0.2);
    expect(remaining(events, start + 3 * DAY, 7)).toBeCloseTo(0.2 * 0.5 ** (3 / 7) + 0.2);
    expect(remaining(events, start + 10 * DAY, 7)).toBeCloseTo(0.2 * 0.5 ** (10 / 7) + 0.1);
    expect(remaining(events, start, null)).toBeNull();
  });
  it("keeps weekly wall-clock schedules across DST and supports multiple weekdays", () => {
    const c = {
      ...scenario("2026", "2026-10-30", "America/Los_Angeles"),
      stages: [{ startWeek: 1, endWeek: 2, units: 3, weekdays: [1, 5], time: "20:00" }],
    };
    const p = plannedInjections(c);
    expect(p).toHaveLength(4);
    expect(p[0]?.at).toBe("2026-10-31T03:00:00.000Z");
    expect(p[1]?.at).toBe("2026-11-03T04:00:00.000Z");
    expect(zonedTime("2026-09-04", "20:00", "America/Los_Angeles")).toBe(
      Date.parse("2026-09-05T03:00:00Z"),
    );
  });
  it("recalculates usage after editing or deleting an arbitrary draw", () => {
    const v = {
      id: "ivl_test",
      courseId: "icr_test",
      label: "Vial",
      volume: 2,
      concentration: 5,
      syringeScale: 100,
      receivedDate: null,
      openedDate: null,
      discardDate: null,
      retired: false,
    };
    const a = {
      id: "inj_test",
      courseId: v.courseId,
      vialId: v.id,
      at: "2026-09-04T20:00:00Z",
      units: 3,
      notes: "",
      plannedAt: null,
    };
    expect(usedVolume(v, [a])).toBe(0.03);
    expect(usedVolume(v, [{ ...a, units: 8 }])).toBe(0.08);
    expect(usedVolume(v, [])).toBe(0);
    expect(usedVolume(v, [a], Date.parse(a.at) - 1)).toBe(0);
  });
  it("rejects ambiguous overlapping stages and invalid dates", () => {
    const c = scenario("2026", "2026-09-04", "America/Los_Angeles");
    expect(courseInput.safeParse({ ...c, stages: [c.stages[0], c.stages[0]] }).success).toBe(false);
    expect(courseInput.safeParse({ ...c, startDate: "2026-02-30" }).success).toBe(false);
  });
});

describe("logged-history forecast", () => {
  it("keeps missed plans out of history and adds only unlinked future plans", () => {
    const course = {
      ...scenario("2026", "2026-09-04", "UTC"),
      id: "icr_test",
      status: "active" as const,
    };
    const plans = plannedInjections(course);
    const now = Date.parse("2026-09-12T00:00:00Z");
    const data: RecordSet = {
      course,
      vials: [
        {
          id: "ivl_test",
          courseId: course.id,
          label: "Vial",
          volume: 2,
          concentration: 5,
          syringeScale: 100,
          receivedDate: null,
          openedDate: null,
          discardDate: null,
          retired: false,
        },
      ],
      injections: [
        {
          id: "inj_test",
          courseId: course.id,
          vialId: "ivl_test",
          at: "2026-09-11T20:00:00Z",
          units: 3,
          plannedAt: plans[2]?.at ?? null,
          notes: "",
        },
      ],
      checkIns: [],
      photos: [],
    };
    const result = projectedDoses(data, now);
    expect(result.actual).toHaveLength(1);
    expect(result.future).toHaveLength(9);
    expect(result.future.every((p) => Date.parse(p.at) > now)).toBe(true);
    expect(remaining(result.projected, now, 7)).toBeCloseTo(remaining(result.actual, now, 7) ?? 0);
    expect(remaining(result.projected, now + 21 * DAY, 7)).toBeGreaterThan(
      remaining(result.actual, now + 21 * DAY, 7) ?? 0,
    );
  });
});
