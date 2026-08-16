import { pool } from "./db/index";
import { PostgresRescueStore } from "./rescue-store";

export const rescueStore = new PostgresRescueStore(pool);
