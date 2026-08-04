import { describe, expect, it } from "vitest";
import { checkinFulfillsGoal, consistencyForDays, scheduleExpectedOn, type ScheduleInput } from "./service";

describe("Goals domain derivation", () => {
  it("does not fulfill a measured occurrence until its target is reached", () => {
    const measured = { kind: "measured" as const, target: 10, reflectivePrompts: null };
    expect(checkinFulfillsGoal({ state: "complete", value: 9, reflection: null }, measured)).toBe(false);
    expect(checkinFulfillsGoal({ state: "complete", value: 10, reflection: null }, measured)).toBe(true);
  });
