import { describe, expect, it } from "vitest";
import { supportiveMilestoneText } from "./common";

describe("supportiveMilestoneText", () => {
  it("rewrites the exact legacy payment-and-shame milestone", () => {
    expect(supportiveMilestoneText("The jar just cracked $100. Disgraceful.")).toBe(
      "The jar reached 100 pts. Keep supporting each other.",
    );
  });

  it("preserves current and unrelated milestone text", () => {
    expect(
      supportiveMilestoneText("The jar reached 100 virtual points. Keep supporting each other."),
    ).toBe("The jar reached 100 virtual points. Keep supporting each other.");
  });
});
