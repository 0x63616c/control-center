import { createFeatureDb } from "@www/core";
import { ENV } from "@www/platform/env";
import * as schema from "./schema";
export const config = ENV.pick("DATABASE_URL", "MEDIA_STORAGE_DIR");
export const db = createFeatureDb(config.DATABASE_URL, schema);
