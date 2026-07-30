import { expect, it } from "vitest";
import { checkDrift } from "../../scripts/apps-check";

// Confirms the committed features/_generated/tiles.gen.ts is byte-identical to
// a fresh in-memory render of the same collect() -> validate() -> renderTiles()
// pipeline apps:gen uses. This is the assertion the 3.3 reviewer flagged as
// missing: nothing previously asserted the committed artifact matches source.
it("reports no drift right after a clean apps:gen", async () => {
  await expect(checkDrift()).resolves.toEqual({ drifted: false, files: [] });
});
