import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkDrift } from "../../scripts/apps-check";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Confirms the committed features/_generated/tiles.gen.ts is byte-identical to
// a fresh in-memory render of the same collect() -> validate() -> renderTiles()
// pipeline apps:gen uses. This is the assertion the 3.3 reviewer flagged as
// missing: nothing previously asserted the committed artifact matches source.
it("reports no drift right after a clean apps:gen", async () => {
  await expect(checkDrift()).resolves.toEqual({ drifted: false, files: [] });
});

it("runs the codegen drift guard in CI's deployment-gating typecheck job", () => {
  const workflow = readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const typecheckJob = workflow.match(/ {2}typecheck:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:|$)/)?.[1];

  expect(typecheckJob).toContain("bun run apps:check");
});
