import { defineWorkerCycles } from "@app-kit";
import { runSonosVolumeEnforcerCycle } from "./enforcer";

export const cycles = defineWorkerCycles([
  {
    name: "sonos-volume-enforcer",
    intervalMs: 1_000,
    runOnStart: true,
    run: runSonosVolumeEnforcerCycle,
  },
]);
