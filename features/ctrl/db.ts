/**
 * The ctrl feature's own Postgres handle (Track C, Wave 7). The feature builds
 * its db from its own {@link config} slice and the shared `createFeatureDb` +
 * `createPgDeviceStateStore` substrate in `@www/core`, rather than importing
 * apps/api's db singleton.
 */
import {
  createFeatureDb,
  createPgDeviceStateStore,
  createPgIntegrationSyncStore,
  deviceState,
  integrationSyncStatus,
} from "@www/core";
import { config } from "./config";
import * as ctrlSchema from "./schema";

export const db = createFeatureDb(config.DATABASE_URL, {
  ...ctrlSchema,
  deviceState,
  integrationSyncStatus,
});
/** The prod device-state store for this feature (pg adapter over the feature db). */
export const deviceStateStore = createPgDeviceStateStore(db);
export const integrationSyncStore = createPgIntegrationSyncStore(db);
