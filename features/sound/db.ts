/**
 * The sound feature's own Postgres handle (Track C, Wave 6). The feature
 * builds its db from its own {@link config} slice and the shared
 * `createFeatureDb` + `createPgDeviceStateStore` + `createPgIntegrationSyncStore`
 * substrate in `@www/core`, rather than importing apps/api's db singleton
 * (mirror features/ctrl/db.ts).
 */
import { createFeatureDb, createPgDeviceStateStore, createPgIntegrationSyncStore } from "@www/core";
import { config } from "./config";

// This feature owns no tables. The shared state stores still need a typed
// Drizzle handle, and createFeatureDb explicitly supports an empty schema.
const db = createFeatureDb(config.DATABASE_URL, {});

/** The prod device-state store for this feature (pg adapter, used by the volume enforcer). */
export const deviceStateStore = createPgDeviceStateStore(db);
/** The prod integration-sync store for this feature (heartbeat rows for the enforcer/poller). */
export const integrationSyncStore = createPgIntegrationSyncStore(db);
