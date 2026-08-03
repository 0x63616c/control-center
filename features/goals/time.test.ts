import { describe, expect, it } from "vitest";
import { goalDayAt, mondayOf, shiftGoalDay } from "./time";

describe("goal-day boundaries", () => {
  it("keeps early-morning check-ins on the previous Los Angeles goal-day", () => {
    expect(goalDayAt(new Date("2026-08-03T09:59:00Z"), "America/Los_Angeles", 3)).toBe(
      "2026-08-02",
    );
    expect(goalDayAt(new Date("2026-08-03T10:00:00Z"), "America/Los_Angeles", 3)).toBe(
      "2026-08-03",
    );
  });

  it("uses Monday as the stable weekly-goal boundary", () => {
    expect(mondayOf("2026-08-03")).toBe("2026-08-03");
    expect(mondayOf("2026-08-09")).toBe("2026-08-03");
    expect(shiftGoalDay("2026-03-01", -1)).toBe("2026-02-28");
  });
});
