import { defineWorkerCycles } from "@app-kit";
import { runWithingsWeightIngestCycle } from "./ingest";

export const cycles = defineWorkerCycles([
  {
    name: "withings-weight-ingest",
    intervalMs: 10_000,
    runOnStart: true,
    run: runWithingsWeightIngestCycle,
  },
]);
