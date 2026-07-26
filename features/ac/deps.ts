/**
 * The ac feature's own device_state store + HA client (Track C, F-devstate ac
 * slice). Built from `@www/core` factories + this feature's own {@link config}
 * slice — the pattern apps/api/src/integrations/homeassistant.ts documents as
 * the intended end-state: each caller builds its own instance from its config
 * slice. This feature's `service.ts` and apps/api's climate-enforcer-service.ts
 * therefore operate independent client/store instances over the SAME HA + the
 * SAME shared `device_state` row (rendezvous via `CLIMATE_DEVICE_ID`) — correct,
 * they are stateless adapters, not owners of state.
 */
import { createFeatureDb, createPgDeviceStateStore, deviceState, haFromConfig } from "@www/core";
import { config } from "./config";

// The device_state store over this feature's own lazy pool (no connection
// until first query).
export const deviceStateStore = createPgDeviceStateStore(
  createFeatureDb(config.DATABASE_URL, { deviceState }),
);

// The env-free HA client bound to this feature's config slice.
export const ha = haFromConfig(config);
