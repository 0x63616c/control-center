import { defineWorkerCycles } from "@app-kit";

// HA's Sonos integration is the sole writer. In particular, do not run a
// second, polling desired-volume enforcer against the speakers.
export const cycles = defineWorkerCycles([]);
