import { describe, expect, it } from "vitest";
import { dueMilestones, type LocalDate } from "./streak-milestones";

describe("streak milestone calendar math", () => {
  it("awards only the exact supported milestones reached in local calendar days", () => {
    expect(dueMilestones("2026-01-08" as LocalDate, "2026-01-01" as LocalDate)).toEqual([
      { days: 7, reachedLocalDate: "2026-01-08" },
    ]);
    expect(dueMilestones("2027-01-01" as LocalDate, "2026-01-01" as LocalDate)).toEqual([
      { days: 7, reachedLocalDate: "2026-01-08" },
      { days: 30, reachedLocalDate: "2026-01-31" },
      { days: 100, reachedLocalDate: "2026-04-11" },
      { days: 365, reachedLocalDate: "2027-01-01" },
    ]);
  });

  it("does not award a future or malformed local date", () => {
    expect(dueMilestones("2026-01-07" as LocalDate, "2026-01-01" as LocalDate)).toEqual([]);
    expect(() => dueMilestones("bad" as LocalDate, "2026-01-01" as LocalDate)).toThrow(
      "invalid local date",
    );
  });
});
