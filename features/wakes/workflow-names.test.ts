import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { temporal } from "./temporal";

// workflows.ts is read as TEXT, never imported: importing it would pull
// `@temporalio/workflow` into a plain node process, outside the determinism
// sandbox it is written for. This still catches the one drift that actually
// breaks production — the facet naming a workflow type nothing exports.
const workflowsSource = readFileSync(new URL("./workflows.ts", import.meta.url), "utf8");

describe("wakes temporal facet workflow type names", () => {
  it("every declared workflowType names a function workflows.ts actually exports", () => {
    expect(temporal.workflowTypes.length).toBeGreaterThan(0);
    for (const type of temporal.workflowTypes) {
      expect(workflowsSource).toMatch(new RegExp(`export async function ${type}\\b`));
    }
  });

  it("registers the activity the workflow proxies", () => {
    const activitiesSource = readFileSync(new URL("./activities.ts", import.meta.url), "utf8");
    expect(activitiesSource).toMatch(/export async function WakesPurgeActivity\b/);
    expect(workflowsSource).toMatch(/const \{ WakesPurgeActivity \} = proxyActivities/);
  });
});
