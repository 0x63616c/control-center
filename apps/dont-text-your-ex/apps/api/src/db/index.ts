import { Pool } from "pg";
import { buildDatabaseUrl } from "../env";

export const pool = new Pool({ connectionString: buildDatabaseUrl() });

// Millisecond timestamp helpers (mirrors the SQLite layer's signatures).
export const now = (): number => Date.now();
export const DAY = 86_400_000;
