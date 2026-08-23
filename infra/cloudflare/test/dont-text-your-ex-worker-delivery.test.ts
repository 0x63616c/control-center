import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const workerRoot = new URL("../workers/dont-text-your-ex-edge/", import.meta.url);

describe("Don't Text Your Ex edge Worker delivery", () => {
  test("pins the five production budgets without exposing the Worker on workers.dev", async () => {
    const config = JSON.parse(await readFile(new URL("wrangler.jsonc", workerRoot), "utf8"));
    expect(config).toMatchObject({
      name: "dont-text-your-ex-edge",
      workers_dev: false,
      preview_urls: false,
      ratelimits: [
        { name: "GENERAL_RATE_LIMITER", simple: { limit: 300, period: 60 } },
        { name: "AUTH_RATE_LIMITER", simple: { limit: 20, period: 60 } },
        { name: "INVITE_RATE_LIMITER", simple: { limit: 20, period: 60 } },
        { name: "REPORT_EVIDENCE_RATE_LIMITER", simple: { limit: 30, period: 60 } },
        { name: "MUTATION_RATE_LIMITER", simple: { limit: 120, period: 60 } },
      ],
    });
    expect(
      new Set(config.ratelimits.map(({ namespace_id }: { namespace_id: string }) => namespace_id))
        .size,
    ).toBe(5);
  });

  test("keeps a separately deployable pass-through version for rollback", async () => {
    const config = JSON.parse(
      await readFile(new URL("wrangler.pass-through.jsonc", workerRoot), "utf8"),
    );
    expect(config).toMatchObject({
      name: "dont-text-your-ex-edge",
      main: "src/pass-through.ts",
      workers_dev: false,
      preview_urls: false,
    });
  });

  test("CI validates and deploys the script before Pulumi attaches its route", async () => {
    const workflow = await readFile(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const job = workflow.slice(
      workflow.indexOf("  deploy-cloudflare:"),
      workflow.indexOf("  notify:"),
    );
    const dryRun = job.indexOf("bun run worker:check");
    const rollbackUpload = job.indexOf("bun run worker:upload:pass-through");
    const scriptDeploy = job.indexOf("bun run worker:deploy");
    const routeApply = job.indexOf("pulumi up --yes --stack");
    expect(dryRun).toBeGreaterThan(-1);
    expect(rollbackUpload).toBeGreaterThan(dryRun);
    expect(scriptDeploy).toBeGreaterThan(rollbackUpload);
    expect(routeApply).toBeGreaterThan(scriptDeploy);
  });

  test("uses Wrangler 4.36 or newer for RateLimit bindings", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", workerRoot), "utf8"));
    expect(manifest.devDependencies.wrangler).toMatch(
      /^\^(?:[5-9]|4\.(?:3[6-9]|[4-9]\d)|[1-9]\d{2,})\./,
    );
  });
});
