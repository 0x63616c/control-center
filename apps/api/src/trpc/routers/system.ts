import { getAscBuildStatus } from "@features/panel-update/service";
import { z } from "zod";
import { publicProcedure, router } from "../init";

// System-level status about the wall panel itself (as opposed to the home it
// controls). appUpdateStatus serves the asc-version-poll worker's cached
// latest-TestFlight-build row; the web client compares it against the installed
// CFBundleVersion (via @capacitor/app) to raise the "update available" banner.
// Null until the poller has succeeded at least once (or ASC is unconfigured).
export const systemRouter = router({
  appUpdateStatus: publicProcedure
    .input(z.object({}).optional())
    .output(
      z
        .object({
          buildNumber: z.number(),
          marketingVersion: z.string(),
          uploadedDate: z.string(),
          fetchedAt: z.string(),
        })
        .nullable(),
    )
    .query(() => getAscBuildStatus()),
});
