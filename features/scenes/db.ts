import { createFeatureDb, createPgDeviceStateStore } from "@www/core";
import { config } from "./config";
import * as schema from "./schema";

export const db = createFeatureDb(config.DATABASE_URL, schema);
export const deviceStateStore = createPgDeviceStateStore(db);
