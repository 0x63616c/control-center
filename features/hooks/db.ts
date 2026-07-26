/**
 * The hooks feature's own Postgres handle, built from its own {@link config}
 * slice via the shared `createFeatureDb` substrate rather than apps/api's db
 * singleton. The pool is lazy, so importing this module (and the branded facets
 * that use it) stays side-effect free for the codegen.
 */
import { createFeatureDb } from "@www/core";
import { config } from "./config";
import * as schema from "./schema";

export const db = createFeatureDb(config.DATABASE_URL, schema);
