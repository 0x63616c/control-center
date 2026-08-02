import { defineWorkerCycles } from "@app-kit";
import { runAscVersionPollCycle } from "./service";

export const cycles = defineWorkerCycles([
  {
    name: "asc-version-poll",
    intervalMs: 60_000,
    runOnStart: true,
    run: runAscVersionPollCycle,
  },
]);
