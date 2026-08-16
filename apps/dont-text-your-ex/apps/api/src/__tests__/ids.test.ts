import { describe, expect, it } from "vitest";
import { id } from "../ids";

describe("durable identifiers", () => {
  it("uses 128 bits of entropy by default", () => {
    expect(id("evt")).toMatch(/^evt_[a-f0-9]{32}$/);
    expect(id("inv")).toMatch(/^inv_[a-f0-9]{32}$/);
  });
});
