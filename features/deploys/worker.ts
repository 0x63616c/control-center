import { defineWorkerCycles } from "@app-kit";
import { runGithubPollCycle } from "./service";

export const cycles = defineWorkerCycles([
  {
    name: "github-actions-poll",
    intervalMs: 10_000,
    runOnStart: true,
    run: runGithubPollCycle,
  },
]);
