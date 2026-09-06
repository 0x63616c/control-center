import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = join(import.meta.dirname, "..");
const rulesText = readFileSync(join(root, "observability/rules/dont-text-your-ex.yaml"), "utf8");
const rules = parse(rulesText) as {
  groups: Array<{ rules: Array<{ alert: string; expr: string }> }>;
};
const alerts = rules.groups.flatMap((group) => group.rules);
const dashboardText = readFileSync(
  join(root, "observability/dashboards/dont-text-your-ex-temporal.json"),
  "utf8",
);

describe("DTYE Temporal operations observability", () => {
  test("alerts cover old, growing and failed outbox plus missing poller and schedules", () => {
    expect(alerts.map((rule) => rule.alert)).toEqual([
      "DtyeOutboxOldestEventStale",
      "DtyeOutboxGrowing",
      "DtyeOutboxHasPermanentFailures",
      "DtyeTemporalMainPollerMissing",
      "DtyeOutboxRecoverySilent",
      "DtyeSessionMaintenanceSilent",
      "DtyeAccountDeletionErasureStuck",
    ]);
    expect(alerts.find((rule) => rule.alert === "DtyeTemporalMainPollerMissing")?.expr).toContain(
      'task_queue="main"',
    );
    expect(alerts.find((rule) => rule.alert === "DtyeOutboxRecoverySilent")?.expr).toContain(
      'activity="outbox_recovery"',
    );
    expect(alerts.find((rule) => rule.alert === "DtyeSessionMaintenanceSilent")?.expr).toContain(
      "> 108000",
    );
    expect(alerts.find((rule) => rule.alert === "DtyeAccountDeletionErasureStuck")?.expr).toContain(
      "www_dtye_account_deletion_erasure_stuck_total",
    );
  });

  test("rules and dashboard never create identity-labelled series", () => {
    expect(`${rulesText}\n${dashboardText}`).not.toMatch(
      /(?:user|jar|event|token|aggregate|workflow)_id\s*=/,
    );
  });

  test("dashboard exposes every requested operational signal", () => {
    expect(dashboardText).toContain("www_dtye_outbox_pending");
    expect(dashboardText).toContain("www_dtye_outbox_oldest_age_seconds");
    expect(dashboardText).toContain('outcome=\\"retry\\"');
    expect(dashboardText).toContain("www_dtye_outbox_permanent_failures");
    expect(dashboardText).toContain("www_dtye_outbox_dispatch_latency_seconds_bucket");
    expect(dashboardText).toContain("www_dtye_session_purge_runs_total");
    expect(dashboardText).toContain("www_dtye_session_purge_deleted_total");
    expect(dashboardText).toContain("www_dtye_session_purge_duration_seconds_bucket");
  });
});
