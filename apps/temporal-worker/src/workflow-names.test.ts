import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEALTH_CHECK_WORKFLOW_TYPE } from "./config";

// workflows.ts is read as TEXT, never imported: importing it would pull
// `@temporalio/workflow` into a plain node process, outside the determinism
// sandbox it is written for. This still catches the one drift that actually
// breaks production — the Schedule naming a workflow type nothing exports.
const workflowsSource = readFileSync(new URL("./workflows.ts", import.meta.url), "utf8");

describe("workflow type names", () => {
  it("HEALTH_CHECK_WORKFLOW_TYPE names a function workflows.ts actually exports", () => {
    expect(workflowsSource).toMatch(
      new RegExp(`export async function ${HEALTH_CHECK_WORKFLOW_TYPE}\\b`),
    );
  });

  it("registers the activity the workflow proxies", () => {
    const activitiesSource = readFileSync(new URL("./activities.ts", import.meta.url), "utf8");
    expect(activitiesSource).toMatch(/export async function HealthCheckActivity\b/);
    expect(workflowsSource).toMatch(/const \{ HealthCheckActivity \} = proxyActivities/);
  });
});
