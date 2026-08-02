/**
 * The ac feature's own device_state store + HA client (Track C, F-devstate ac
 * slice). Built from `@www/core` factories + this feature's own {@link config}
 * slice — the pattern apps/api/src/integrations/homeassistant.ts documents as
 * the intended end-state: each caller builds its own instance from its config
 * slice. The API service and App-owned enforcer operate independent adapters
 * over the same HA instance and shared `device_state` row.
 */
import {
  createFeatureDb,
  createPgDeviceStateStore,
  createPgIntegrationSyncStore,
  deviceState,
  haFromConfig,
  integrationSyncStatus,
} from "@www/core";
import { config } from "./config";

const db = createFeatureDb(config.DATABASE_URL, { deviceState, integrationSyncStatus });
export const deviceStateStore = createPgDeviceStateStore(db);
export const integrationSyncStore = createPgIntegrationSyncStore(db);

// The env-free HA client bound to this feature's config slice.
export const ha = haFromConfig(config);
