import { describe, expect, it } from "vitest";
import { ReportIdSchema } from "../../../contracts";
import {
  createReportAccountabilityActivities,
  type ReportAccountabilityStore,
} from "./report-accountability";

const reportId = ReportIdSchema.parse("rpt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

describe("ReportAccountabilityActivity", () => {
  it("keeps activity history limited to the opaque report id and machine state", async () => {
    const calls: unknown[] = [];
    const store: ReportAccountabilityStore = {
      async advance(input) {
        calls.push(input);
        return {
          state: "pending",
          reportId,
          aggregateVersion: 1,
          createdAt: 1_700_000_000_000,
        };
      },
    };
    const activities = createReportAccountabilityActivities({ store });

    await expect(
      activities.ReportAccountabilityActivity({ reportId, action: "remind_24h" }),
    ).resolves.toEqual({
      state: "pending",
      reportId,
      aggregateVersion: 1,
      createdAt: 1_700_000_000_000,
    });
    expect(calls).toEqual([{ reportId, action: "remind_24h" }]);
    expect(JSON.stringify(calls)).not.toContain("usr_");
  });
});
