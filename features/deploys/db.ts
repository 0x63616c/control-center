/**
 * The deploys feature's own Postgres handle (Track C, Wave 2). The feature
 * builds its db from its own {@link config} slice and the shared
 * `createFeatureDb` substrate in `@www/core`, rather than importing apps/api's
 * db singleton. The pool is lazy (no connection until first query), so
 * importing this module — and therefore the branded facets that use it
 * (api.ts) — is side-effect free enough for the codegen to load.
 */
import { createFeatureDb } from "@www/core";
import { config } from "./config";
import * as schema from "./schema";

export const db = createFeatureDb(config.DATABASE_URL, schema);
