import { readFile } from "node:fs/promises";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const projectConfigs = [
  "tsconfig.config.json",
  "apps/manage/tsconfig.json",
  "apps/temporal-worker/tsconfig.json",
  "apps/web/tsconfig.json",
  "apps/worker/tsconfig.json",
  "packages/api/tsconfig.json",
  "packages/core/tsconfig.json",
  "packages/logger/tsconfig.json",
  "packages/platform/tsconfig.json",
  "packages/worker-runtime/tsconfig.json",
  "infra/tsconfig.json",
  "infra/cloudflare/tsconfig.json",
  "infra/unifi/tsconfig.json",
] as const;

async function readConfig(path: string): Promise<Record<string, unknown>> {
  const parsed = ts.parseConfigFileTextToJson(path, await readFile(path, "utf8"));

  if (parsed.error || !parsed.config) {
    throw new Error(`Could not parse ${path}`);
  }

  return parsed.config as Record<string, unknown>;
}

describe("typecheck project references", () => {
  it("uses one root build and composite referenced projects", async () => {
    const packageJson = await readConfig("package.json");
    const scripts = packageJson.scripts as Record<string, string>;
    const solution = await readConfig("tsconfig.json");
    const references = solution.references as readonly { path: string }[];

    expect(scripts.typecheck).toBe("tsc -b");
    expect(scripts).not.toHaveProperty("typecheck:config");
    expect(references).toHaveLength(projectConfigs.length);

    for (const configPath of projectConfigs) {
      const config = await readConfig(configPath);
      const compilerOptions = config.compilerOptions as Record<string, unknown>;

      expect(compilerOptions.composite).toBe(true);
      expect(compilerOptions.tsBuildInfoFile).toMatch(/dist\/.*\.tsbuildinfo$/);
    }
  });
});
