// Public @www/core surface for the Home Assistant client. Mirrors the UniFi
// barrel: the client lives in ./client (env-free, mandatory-args); this re-exports
// only the names consumers depend on. `HomeAssistantClientOptions` stays
// package-private (callers pass an object literal to createHomeAssistantClient).
export type { HaEntity } from "./client";
export { createHomeAssistantClient, HaError, HomeAssistantClient, haFromConfig } from "./client";
