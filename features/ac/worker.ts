import { defineWorkerCycles } from "@app-kit";
import { runClimateEnforcerCycle } from "./enforcer";

export const cycles = defineWorkerCycles([
  {
    name: "climate-enforcer",
    intervalMs: 1_000,
    runOnStart: true,
    run: runClimateEnforcerCycle,
  },
]);
