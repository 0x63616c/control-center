import { createFeatureDb } from "@www/core";
import { config } from "./config";
import * as schema from "./schema";

/** The Goals feature owns its queries but shares the app's pooled connection. */
export const db = createFeatureDb(config.DATABASE_URL, schema);
