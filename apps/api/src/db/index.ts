import { createFeatureDb } from "@www/core";
import { ENV as config } from "@www/platform/env";
import * as schema from "./schema";

export const db = createFeatureDb(config.DATABASE_URL, schema);
