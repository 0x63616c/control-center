/**
 * The weight feature's own Postgres handle (Track C, Wave 2). The feature
 * builds its db from its own {@link config} slice and the shared
 * `createFeatureDb` substrate in `@www/core`, rather than importing apps/api's
 * db singleton. The pool is lazy (no connection until first query), so
 * importing this module — and therefore the branded facets that use it
 * (api.ts) — is side-effect free enough for the codegen to load.
 *
 * The weight-ingest interval cycle (apps/api/src/services/weight-service.ts)
 * and this feature's own api.ts/service.ts query surface both resolve
 * `config.DATABASE_URL` to the same connection string, so `createFeatureDb`
 * memoizes them onto the SAME underlying pool — one shared pool against the
 * `weight_measurement` table from the same process tree, not two.
 */
import { createFeatureDb } from "@www/core";
import { config } from "./config";
import * as schema from "./schema";

export const db = createFeatureDb(config.DATABASE_URL, schema);
