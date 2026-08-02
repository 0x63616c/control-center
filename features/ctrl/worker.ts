import { defineWorkerCycles } from "@app-kit";
import { runDeviceSyncCycle } from "./device-sync";
import { runEnforcerCycle } from "./light-enforcer";
import { reconcilePartyMode } from "./party";

export const cycles = defineWorkerCycles([
  {
    name: "light-enforcer",
    intervalMs: 1_000,
    runOnStart: true,
    run: runEnforcerCycle,
  },
  {
    name: "device-sync",
    intervalMs: 1_000,
    runOnStart: true,
    run: runDeviceSyncCycle,
  },
  {
    name: "party-mode",
    intervalMs: 2_000,
    runOnStart: true,
    run: reconcilePartyMode,
  },
]);
