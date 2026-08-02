import { defineWorkerCycles } from "@app-kit";
import { runWeatherIngestCycle } from "./ingest";

export const cycles = defineWorkerCycles([
  {
    name: "weather-ingest",
    intervalMs: 5 * 60_000,
    runOnStart: true,
    run: runWeatherIngestCycle,
  },
]);
