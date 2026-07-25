import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// DATABASE_URL derivation from the mounted POSTGRES_PASSWORD secret moved to
// @www/platform/env (databaseUrlFromSecret in packages/platform/env/hydrate.ts)
// when the env registry took ownership of env end-to-end (design spec §3).
// pool.ts keeps only the pure connectionString -> Pool factory; it reads no env.
export function createPool(url: string): Pool {
  return new Pool({ connectionString: url, max: MAX_POOL_CONNECTIONS });
}

// Live-checked ceiling, not a guess: `show max_connections;` on the
// control-center CNPG cluster (control-center-1) reads 100, with
// pg_stat_activity sitting around 20 as a baseline (other sessions
// included). control_center's Postgres is dedicated to this namespace's own
// processes (api, web, worker) per infra/src/cnpg.ts — no cross-product
// sharing since captive-portal's DB was torn down. 10 is node-postgres's own
// library default; even at 5x today's process count (api + worker + web,
// each holding exactly one pool post-createFeatureDb-fold instead of the ~13
// independent pools features/*/db.ts used to create), that's 5 x 10 = 50,
// well under the 100 ceiling with headroom for manual psql sessions and
// future replica scale-out.
export const MAX_POOL_CONNECTIONS = 10;

/** The handle `createFeatureDb` returns: a drizzle db plus its underlying `pg.Pool` via `$client`. */
export type FeatureDb<TSchema extends Record<string, unknown>> = NodePgDatabase<TSchema> & {
  $client: Pool;
};

const poolsByUrl = new Map<string, FeatureDb<Record<string, unknown>>>();

/**
 * Returns the process-wide drizzle handle for `url`, creating and memoizing
 * the underlying `pg.Pool` on first call. Every feature's `db.ts` (and
 * apps/api's own db module) call this instead of constructing their own
 * `Pool`, so a single process holds exactly one pool per distinct connection
 * string no matter how many features it imports — not one pool per feature.
 *
 * Correctness of the memoization depends on every caller's `url` for the
 * same physical database resolving to the identical string (same
 * host/db/user); in this repo that's guaranteed by every feature and
 * apps/api sourcing `DATABASE_URL` from the single shared env registry key
 * (packages/platform/env/manifest.ts), not a per-feature slice. A future
 * per-feature database split would need to revisit this precondition.
 *
 * The generic `schema` type is per-call-site only — the runtime cache is
 * keyed purely by `url`, so the first caller for a given URL determines the
 * pool's lifecycle and every later caller with that same URL gets back a
 * handle typed against its own `schema` argument over the same pool.
 */
export function createFeatureDb<TSchema extends Record<string, unknown>>(
  url: string,
  schema: TSchema,
): FeatureDb<TSchema> {
  const cached = poolsByUrl.get(url);
  if (cached) return cached as FeatureDb<TSchema>;

  const db = drizzle(createPool(url), { schema });
  poolsByUrl.set(url, db as FeatureDb<Record<string, unknown>>);
  return db;
}
