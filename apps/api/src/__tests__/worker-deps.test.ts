/**
 * Tests for the durable `job` table schema, which remains app-level while
 * feature-owned job handlers are generated from their manifests.
 */
import { describe, expect, it } from "vitest";
import { job } from "../db/schema";

describe("job table schema", () => {
  it("dropped result/lockedBy columns are absent", () => {
    const cols = Object.keys(job);
    for (const dropped of ["result", "lockedBy"]) {
      expect(cols).not.toContain(dropped);
    }
  });

  it("lockedAt is kept (the stale-job reaper keys off it)", () => {
    const cols = Object.keys(job);
    expect(cols).toContain("lockedAt");
  });
});
