/**
 * The sound feature's own Postgres handle (Track C, Wave 6). The feature
 * builds its db from its own {@link config} slice and the shared
 * `createFeatureDb` + `createPgDeviceStateStore` + `createPgIntegrationSyncStore`
 * substrate in `@www/core`, rather than importing apps/api's db singleton
 * (mirror features/ctrl/db.ts). `db` is also the raw drizzle handle used by
 * ingest.ts/poller.ts for direct mediaSource/mediaItem reads+writes.
 */
import { createFeatureDb, createPgDeviceStateStore, createPgIntegrationSyncStore } from "@www/core";
import { config } from "./config";
import * as schema from "./schema";

export const db = createFeatureDb(config.DATABASE_URL, schema);

/** The prod device-state store for this feature (pg adapter, used by the volume enforcer). */
export const deviceStateStore = createPgDeviceStateStore(db);
/** The prod integration-sync store for this feature (heartbeat rows for the enforcer/poller). */
export const integrationSyncStore = createPgIntegrationSyncStore(db);
