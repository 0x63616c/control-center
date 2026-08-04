import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  assembleDays,
  calendarDay,
  dailyMedians,
  dayExpr,
  formatWeighInAlert,
  isOutsideSanityBand,
  median,
  metricExpr,
  metricInput,
  summarize,
  WEIGHT_METRICS,
} from "./service";

describe("median", () => {
  it("odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe("formatWeighInAlert", () => {
  it("converts kg to lb, rounded to 1 decimal", () => {
    expect(formatWeighInAlert(72.5)).toEqual({
      title: "New weight logged: 159.8lbs",
      body: "",
    });
  });
  it("rounds at the boundary", () => {
    expect(formatWeighInAlert(50)).toEqual({
      title: "New weight logged: 110.2lbs",
      body: "",
    });
  });
});

describe("isOutsideSanityBand", () => {
  const recent = [81.6, 81.8, 82.0, 82.2];
  it("passes normal readings", () => {
    expect(isOutsideSanityBand(81.0, recent)).toBe(false);
  });
  it("flags a guest 15kg away", () => {
    expect(isOutsideSanityBand(97.0, recent)).toBe(true);
  });
  it("inactive with fewer than 3 prior readings", () => {
    expect(isOutsideSanityBand(97.0, [81.6, 81.8])).toBe(false);
  });
});

describe("dailyMedians", () => {
  it("reduces same-day multiples to the median and sorts by day", () => {
    const rows = [
      { day: "2026-07-16", weightKg: 82.2 },
      { day: "2026-07-16", weightKg: 82.0 },
      { day: "2026-07-15", weightKg: 81.9 },
    ];
    expect(dailyMedians(rows)).toEqual([
      { day: "2026-07-15", kg: 81.9 },
      { day: "2026-07-16", kg: 82.1 },
    ]);
  });

  it("trusts the caller's day key rather than re-deriving one", () => {
    // Both readings are the same UTC instant bucketed into different local
    // days — exactly what a timezone boundary produces. The domain must not
    // second-guess the key it was handed.
    const rows = [
      { day: "2026-07-15", weightKg: 80.0 },
      { day: "2026-07-16", weightKg: 90.0 },
    ];
    expect(dailyMedians(rows)).toEqual([
      { day: "2026-07-15", kg: 80.0 },
      { day: "2026-07-16", kg: 90.0 },
    ]);
  });
});

describe("summarize", () => {
  it("low/high come from raw readings, average/change from daily medians", () => {
    const s = summarize(
      [
        { day: "2026-07-15", kg: 82.0 },
        { day: "2026-07-16", kg: 81.0 },
        { day: "2026-07-17", kg: 81.5 },
      ],
      [82.4, 81.6, 80.6, 81.4, 81.6],
    );
    expect(s).toEqual({ low: 80.6, high: 82.4, average: 81.5, change: -0.5 });
  });

  it("a single day still reports a real spread — the shipped bug", () => {
    // Four readings, one day. low/high/average used to collapse to the median.
    const s = summarize([{ day: "2026-07-22", kg: 72.85 }], [72.65, 72.75, 72.95, 73.0]);
    expect(s?.low).toBe(72.65);
    expect(s?.high).toBe(73.0);
    expect(s?.average).toBe(72.85);
    expect(s?.change).toBe(0);
  });

  it("null on empty", () => {
    expect(summarize([], [])).toBeNull();
  });
});

const dialect = new PgDialect();

describe("calendarDay", () => {
  it("buckets one historical instant by the explicit configured zone", () => {
    const instant = new Date("2026-03-08T07:30:00Z");
    expect(calendarDay(instant, "America/Los_Angeles")).toBe("2026-03-07");
    expect(calendarDay(instant, "Europe/London")).toBe("2026-03-08");
  });
});

describe("dayExpr", () => {
  it("binds the timezone as a parameter, never inlines it", () => {
    const { params, sql } = dialect.sqlToQuery(dayExpr("America/Los_Angeles"));
    expect(params).toContain("America/Los_Angeles");
    expect(sql).not.toContain("America/Los_Angeles");
  });
});

describe("metricExpr", () => {
  it("reads weight from its own column, not the jsonb", () => {
    const { sql } = dialect.sqlToQuery(metricExpr("weight_kg"));
    expect(sql).toContain("weight_kg");
    expect(sql).not.toContain("body_metrics");
  });

  it("reads body composition out of the jsonb as a number", () => {
    const { params, sql } = dialect.sqlToQuery(metricExpr("fat_ratio_percent"));
    expect(sql).toContain("body_metrics");
    expect(sql).toContain("double precision");
    // The key is bound, never concatenated into the statement.
    expect(params).toContain("fat_ratio_percent");
    expect(sql).not.toContain("'fat_ratio_percent'");
  });
});

describe("metricInput", () => {
  it("accepts every declared metric", () => {
    for (const key of Object.keys(WEIGHT_METRICS)) {
      expect(metricInput.parse(key)).toBe(key);
    }
  });
  it("rejects an unknown metric rather than passing it into SQL", () => {
    expect(() => metricInput.parse("bmi")).toThrow();
    expect(() => metricInput.parse("weight_kg; drop table weight_measurement")).toThrow();
  });
});

describe("WEIGHT_METRICS", () => {
  it("marks the fat ratio as a percentage and every mass as kg", () => {
    // The unit drives whether the web layer applies the lb conversion; getting
    // this wrong renders a fat ratio of 17.1% as 37.7.
    expect(WEIGHT_METRICS.fat_ratio_percent.unit).toBe("percent");
    for (const [key, m] of Object.entries(WEIGHT_METRICS)) {
      if (key !== "fat_ratio_percent") expect(m.unit).toBe("kg");
    }
  });
});

describe("assembleDays", () => {
  const rows = [
    {
      id: "wm_3",
      day: "2026-07-22",
      measuredAt: new Date("2026-07-22T18:43:00Z"),
      weightKg: 72.65,
      excludedReason: null,
    },
    {
      id: "wm_2",
      day: "2026-07-22",
      measuredAt: new Date("2026-07-22T16:55:00Z"),
      weightKg: 72.95,
      excludedReason: null,
    },
    {
      id: "wm_1",
      day: "2026-07-21",
      measuredAt: new Date("2026-07-21T15:40:00Z"),
      weightKg: 73.1,
      excludedReason: null,
    },
  ];

  it("passes body composition through, and normalises its absence to null", () => {
    const withComp = [
      {
        id: "wm_a",
        day: "2026-07-22",
        measuredAt: new Date("2026-07-22T17:10:00Z"),
        weightKg: 72.6,
        excludedReason: null,
        bodyMetrics: { fat_ratio_percent: 17.067, muscle_mass_kg: 57.19 },
      },
      // A weight-only Withings sync: no body composition reported at all.
      {
        id: "wm_b",
        day: "2026-07-22",
        measuredAt: new Date("2026-07-22T16:55:00Z"),
        weightKg: 72.95,
        excludedReason: null,
      },
    ];
    const [day] = assembleDays(withComp);
    expect(day?.readings[0]?.bodyMetrics).toEqual({
      fat_ratio_percent: 17.067,
      muscle_mass_kg: 57.19,
    });
    // undefined would serialise away; null is the explicit "never had any".
    expect(day?.readings[1]?.bodyMetrics).toBeNull();
  });

  it("groups newest day first with medians and day-over-day deltas", () => {
    const days = assembleDays(rows);
    expect(days.map((d) => d.day)).toEqual(["2026-07-22", "2026-07-21"]);
    expect(days[0]?.medianKg).toBeCloseTo(72.8);
    // vs the previous RECORDED day, which may not be yesterday.
    expect(days[0]?.dayDeltaKg).toBeCloseTo(-0.3);
    // The oldest day in the page has nothing before it.
    expect(days[1]?.dayDeltaKg).toBeNull();
  });

  it("readings are newest first and delta compares to the previous included one", () => {
    const [today] = assembleDays(rows);
    expect(today?.readings.map((r) => r.id)).toEqual(["wm_3", "wm_2"]);
    expect(today?.readings[0]?.deltaKg).toBeCloseTo(-0.3);
    expect(today?.readings[1]?.deltaKg).toBeNull();
  });

  it("excluded readings are listed but do not move the median", () => {
    const withGuest = [
      {
        id: "wm_x",
        day: "2026-07-22",
        measuredAt: new Date("2026-07-22T15:00:00Z"),
        weightKg: 95,
        excludedReason: "sanity_band",
      },
      ...rows,
    ];
    const [today] = assembleDays(withGuest);
    expect(today?.readings).toHaveLength(3);
    expect(today?.medianKg).toBeCloseTo(72.8);
  });

  it("a day whose only reading is excluded has a null median, not NaN or 0", () => {
    const allExcluded = [
      {
        id: "wm_guest",
        day: "2026-07-22",
        measuredAt: new Date("2026-07-22T15:00:00Z"),
        weightKg: 95,
        excludedReason: "sanity_band",
      },
      ...rows.filter((r) => r.day === "2026-07-21"),
    ];
    const days = assembleDays(allExcluded);
    const today = days.find((d) => d.day === "2026-07-22");
    expect(today?.medianKg).toBeNull();
  });

  it("a neighbour with a null median leaves dayDeltaKg null rather than NaN", () => {
    const allExcluded = [
      {
        id: "wm_guest",
        day: "2026-07-22",
        measuredAt: new Date("2026-07-22T15:00:00Z"),
        weightKg: 95,
        excludedReason: "sanity_band",
      },
      ...rows.filter((r) => r.day === "2026-07-21"),
    ];
    const days = assembleDays(allExcluded);
    const today = days.find((d) => d.day === "2026-07-22");
    expect(today?.dayDeltaKg).toBeNull();
  });

  it("the oldest day fetched only as delta context still gives the last real day a delta", () => {
    // Simulates the router fetching one extra (older) day beyond the page,
    // purely so the last real day's delta isn't stranded at a page boundary.
    const withContextDay = [
      ...rows,
      {
        id: "wm_context",
        day: "2026-07-20",
        measuredAt: new Date("2026-07-20T15:40:00Z"),
        weightKg: 73.4,
        excludedReason: null,
      },
    ];
    const days = assembleDays(withContextDay);
    // 2026-07-21 is the last day of the "page"; 2026-07-20 is context-only.
    const lastPageDay = days.find((d) => d.day === "2026-07-21");
    expect(lastPageDay?.dayDeltaKg).toBeCloseTo(73.1 - 73.4);
    // The context day itself is the last entry, ready for the caller to drop.
    expect(days[days.length - 1]?.day).toBe("2026-07-20");
  });
});
