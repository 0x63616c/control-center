/**
 * The notify job facet (Track C, S1). Registers the APNs fan-out handler on
 * the S1 job seam: codegen collects this via `defineJobs`, emits it into
 * `features/_generated/jobs.gen.ts`, and the worker drains it generically ,
 * zero hand-wiring at the worker entrypoint.
 *
 * Keep this module's import surface light so codegen can import it under
 * jsdom/bun without side effects (apns is env-gated + opens no top-level
 * connection; db is lazy , same constraint guest-wifi/jobs.ts already
 * satisfies).
 */
import { defineJobs } from "@app-kit";
import { runNotifyJob, runRaiseNotificationJob } from "./service";

// Also declared in ./service.ts (the file every consuming tsc program actually
// imports); see the comment there for why. Declared here too, at the facet's
// definition site, for local readability , TS interface merging is idempotent
// across identical declarations within one program.
declare module "@www/core" {
  interface JobTypeRegistry {
    notify: { notificationId: string };
  }
}

export const jobs = defineJobs([
  { type: "notify", handler: runNotifyJob, maxMs: 60_000 },
  { type: "raise_notification", handler: runRaiseNotificationJob, maxMs: 60_000 },
]);
