import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
// scripts/ has no tsconfig with the @app-kit alias (bun resolves paths from the
// tsconfig nearest each file), so reach the authoring surface by relative path.
import {
  type AppManifest,
  HTTP_FACET_BRAND,
  JOBS_FACET_BRAND,
  TEMPORAL_FACET_BRAND,
  type TemporalFacet,
  TILE_VIEWS_FACET_BRAND,
  type TileViewDeclaration,
} from "../../app-kit/index";

// scripts/apps-gen/collect.ts -> repo root is two directories up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FEATURES_DIR = join(REPO_ROOT, "features");
const BASE_SCHEMA = join(REPO_ROOT, "apps", "api", "src", "db", "schema.ts");

/** A single collected tile (one per TileSpec). */
interface CollectedTile {
  id: string;
  label: string;
  worldCol: number;
  worldRow: number;
  cols: number;
  rows: number;
  home: boolean;
}

/** @public shared shape between collect() and validate(); consumed by the codegen emitter. */
export interface CollectedApp {
  id: string;
  /** Owning features/<dir> folder, used to validate App-local facet ownership. */
  featureDir: string;
  tiles: CollectedTile[];
  guestExposed: boolean;
  sensitive: boolean;
  private: boolean;
  source: "feature" | "registry";
}

/** A collected pgTable, tagged with where it was declared (feature vs base schema). */
interface CollectedTable {
  name: string;
  source: string;
}

/**
 * A collected named export off a schema.ts module (feature or base), tagged
 * with its source. schema.gen.ts is a flat `export *` barrel across every
 * folded feature's schema.ts plus the base apps/api schema.ts, so two schema
 * modules exporting the same symbol name would silently last-write-win in the
 * barrel; this feeds the dup-export-name check in validate.ts.
 */
interface CollectedSchemaExport {
  name: string;
  source: string;
}

/** A collected top-level tRPC router key, tagged with its owning feature. */
interface CollectedRouterKey {
  key: string;
  source: string;
}

/** A collected `defineJobs` facet entry , the worker folds these generically. */
interface CollectedJob {
  type: string;
  maxMs: number;
  source: string;
}

/** A collected `defineHttp` route (S3), read for the dup-route validator. */
interface CollectedHttpRoute {
  method: string | undefined;
  path: string;
  match: "exact" | "prefix";
  source: string;
}

/**
 * A collected http facet MODULE (S3), for the `http.gen.ts` emit barrel.
 * `importPath` is relative from `features/_generated/`.
 */
interface CollectedHttpModule {
  ident: string;
  importPath: string;
  source: string;
}

/**
 * A collected workflow type name off a `defineTemporal` facet (ADR-0008), for
 * the dup-workflow-type validator. The implementation is NEVER imported here —
 * `workflows.ts` may only be loaded inside the Temporal sandbox's bundler.
 */
interface CollectedWorkflowType {
  type: string;
  source: string;
}

/**
 * A collected Temporal Schedule (ADR-0008), fully composed: `scheduleId` is the
 * FULL Temporal schedule ID (`app_<dir>_<localId>`), which doubles as the
 * managed-by marker the temporal-worker's boot reconciler keys on. `argsJson`
 * carries the workflow's single argument pre-serialised so the emitter's data
 * listing stays trivially deterministic.
 */
interface CollectedTemporalSchedule {
  scheduleId: string;
  workflowType: string;
  cron: string;
  timezone: string | undefined;
  argsJson: string | undefined;
  timeout: string | undefined;
  catchupWindow: string | undefined;
  source: string;
}

/**
 * A collected activity export name off `features/<dir>/activities.ts` (imported
 * data-only, like api.ts — the module top-level must stay side-effect free).
 * Feeds the dup-activity-name validator: GENERATED_ACTIVITIES is one merged
 * object, so two features exporting the same activity name would silently
 * last-write-win.
 */
interface CollectedActivity {
  name: string;
  source: string;
}

/** One App-owned Tile View declaration from features/<id>/detail.ts. */
interface CollectedTileView {
  tileId: string;
  source: string;
}

/**
 * Per-feature emit metadata — everything the emitter needs to render the
 * generated router/guest-router/schema aggregates as deterministic import
 * barrels. `dir` is the feature folder name (relative import base from
 * features/_generated/).
 */
export interface CollectedFeature {
  dir: string;
  id: string;
  guestExposed: boolean;
  hasApi: boolean;
  hasSchema: boolean;
  hasJobs: boolean;
  hasHttp: boolean;
  /** True when the App has a branded detail.ts Tile View facet. */
  hasDetail: boolean;
  /** True when the feature has a `defineTemporal` facet (temporal.ts, ADR-0008). */
  hasTemporal: boolean;
  /** True when the feature ships `activities.ts` (requires hasTemporal). */
  hasActivities: boolean;
}

export interface AppModel {
  apps: CollectedApp[];
  features: CollectedFeature[];
  tables: CollectedTable[];
  schemaExports: CollectedSchemaExport[];
  routerKeys: CollectedRouterKey[];
  jobs: CollectedJob[];
  httpRoutes: CollectedHttpRoute[];
  httpModules: CollectedHttpModule[];
  workflowTypes: CollectedWorkflowType[];
  temporalSchedules: CollectedTemporalSchedule[];
  activities: CollectedActivity[];
  tileViews: CollectedTileView[];
}

const APP_BRAND = Symbol.for("app-kit.app");

/** Enforce the single conventional export consumed by the generated import. */
export function collectTileViewsExport(
  detailMod: Record<string, unknown>,
  dir: string,
): TileViewDeclaration[] {
  const branded = Object.entries(detailMod).filter(
    ([, value]) =>
      Array.isArray(value) && Boolean((value as Record<symbol, unknown>)[TILE_VIEWS_FACET_BRAND]),
  );
  if (branded.length !== 1 || branded[0][0] !== "tileViews") {
    throw new Error(
      `features/${dir}/detail.ts must export exactly one defineTileViews() facet named tileViews`,
    );
  }
  return branded[0][1] as TileViewDeclaration[];
}

/**
 * S3 transitional: booth/wake raw routes lived in apps/api until F-booth/F-wakes
 * folded their tiles. Each fold DELETES its entry here and adds a
 * features/<id>/http.ts (picked up by the featureDirs() scan above instead).
 * PERMANENTLY EMPTY as of F-booth (the last entry, booth, folded) — every http
 * facet now collects via Source A. Kept (rather than deleted outright) as the
 * documented escape hatch for a future S3-shaped seam; the loop below is a
 * no-op over an empty list.
 */
const INTERIM_HTTP_MODULES: readonly {
  file: string;
  ident: string;
  importPath: string;
  source: string;
}[] = [];

/**
 * Read a `defineHttp([...])` facet (an array branded with HTTP_FACET_BRAND) off
 * an imported module's `routes` export. Reads only `method`/`path`/`match` off
 * each spec , NEVER invokes `handler` (mirrors the jobs scan's data-only read).
 */
function readHttpRoutes(mod: Record<string, unknown>, source: string): CollectedHttpRoute[] {
  const v = mod.routes;
  if (!Array.isArray(v) || !(v as Record<symbol, unknown>)[HTTP_FACET_BRAND]) return [];
  return (v as Array<{ method?: string; path: string; match?: "exact" | "prefix" }>).map((r) => ({
    method: r.method,
    path: r.path,
    match: r.match ?? "exact",
    source,
  }));
}

/** Enumerate feature folders (features/<dir>/manifest.ts), sorted, skipping _generated. */
function featureDirs(): string[] {
  return readdirSync(FEATURES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name)
    .filter((name) => existsSync(join(FEATURES_DIR, name, "manifest.ts")))
    .sort();
}

/** features/<dir>/… -> a valid JS identifier base, e.g. "guest-wifi" -> "guestWifi". */
function ident(dir: string): string {
  return dir.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Collect every exported drizzle pgTable name from a schema module. */
function tableNames(mod: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const v of Object.values(mod)) {
    if (is(v, Table)) names.push(getTableConfig(v).name);
  }
  return names;
}

/**
 * Collect the whole App model as one consistent whole. Every Tile comes from
 * its App manifest and every Tile View comes from the owning App's detail.ts
 * facet; there is no registry fallback. The schema union, router keys, and
 * remaining facets ride alongside so validation can reject collisions and the
 * emitter can render every static runtime aggregate.
 */
export async function collect(): Promise<AppModel> {
  const dirs = featureDirs();

  const featureApps: CollectedApp[] = [];
  const features: CollectedFeature[] = [];
  const tables: CollectedTable[] = [];
  const schemaExports: CollectedSchemaExport[] = [];
  const routerKeys: CollectedRouterKey[] = [];
  const jobs: CollectedJob[] = [];
  const httpRoutes: CollectedHttpRoute[] = [];
  const httpModules: CollectedHttpModule[] = [];
  const workflowTypes: CollectedWorkflowType[] = [];
  const temporalSchedules: CollectedTemporalSchedule[] = [];
  const activities: CollectedActivity[] = [];
  const tileViews: CollectedTileView[] = [];

  for (const dir of dirs) {
    const base = join(FEATURES_DIR, dir);

    const manifestMod = (await import(join(base, "manifest.ts"))) as { default: AppManifest };
    const m = manifestMod.default;
    if (!(m as Record<symbol, unknown>)[APP_BRAND]) {
      throw new Error(`features/${dir}/manifest.ts default export is not a defineApp() manifest`);
    }
    featureApps.push({
      id: m.id,
      featureDir: dir,
      tiles: m.tiles.map((t) => ({
        id: t.id,
        label: t.label,
        worldCol: t.worldCol,
        worldRow: t.worldRow,
        cols: t.cols,
        rows: t.rows,
        home: Boolean(t.home),
      })),
      guestExposed: Boolean(m.guestExposed),
      sensitive: Boolean(m.sensitive),
      private: Boolean(m.private),
      source: "feature",
    });

    const hasSchema = existsSync(join(base, "schema.ts"));
    if (hasSchema) {
      const schemaMod = (await import(join(base, "schema.ts"))) as Record<string, unknown>;
      for (const name of tableNames(schemaMod)) tables.push({ name, source: `feature:${dir}` });
      for (const name of Object.keys(schemaMod)) {
        schemaExports.push({ name, source: `feature:${dir}` });
      }
    }

    const hasApi = existsSync(join(base, "api.ts"));
    if (hasApi) {
      const apiMod = (await import(join(base, "api.ts"))) as {
        api?: { _def?: { record?: object } };
      };
      const record = apiMod.api?._def?.record ?? {};
      for (const key of Object.keys(record)) routerKeys.push({ key, source: `feature:${dir}` });
    }

    let hasDetail = false;
    const detailPath = join(base, "detail.ts");
    if (existsSync(detailPath)) {
      const detailMod = (await import(detailPath)) as Record<string, unknown>;
      const declarations = collectTileViewsExport(detailMod, dir);
      hasDetail = true;
      for (const declaration of declarations) {
        tileViews.push({ tileId: declaration.tileId, source: `feature:${dir}` });
      }
    } else if (m.tiles.length > 0) {
      throw new Error(
        `features/${dir}/manifest.ts declares Tiles but features/${dir}/detail.ts is missing`,
      );
    }

    let hasJobs = false;
    if (existsSync(join(base, "jobs.ts"))) {
      const jobsMod = (await import(join(base, "jobs.ts"))) as Record<string, unknown>;
      for (const v of Object.values(jobsMod)) {
        // A `defineJobs([...])` facet: an array branded with JOBS_FACET_BRAND.
        // Read only `type` + `maxMs` off each spec , never invoke the handler.
        if (Array.isArray(v) && (v as Record<symbol, unknown>)[JOBS_FACET_BRAND]) {
          hasJobs = true;
          for (const spec of v as Array<{ type: string; maxMs: number }>) {
            jobs.push({ type: spec.type, maxMs: spec.maxMs, source: `feature:${dir}` });
          }
        }
      }
    }

    // Source A , future feature http facets: features/<dir>/http.ts, collected
    // the same way api.ts/jobs.ts are (never via the interim list below).
    let hasHttp = false;
    if (existsSync(join(base, "http.ts"))) {
      const httpMod = (await import(join(base, "http.ts"))) as Record<string, unknown>;
      const routes = readHttpRoutes(httpMod, `feature:${dir}`);
      if (routes.length > 0) {
        hasHttp = true;
        httpRoutes.push(...routes);
        httpModules.push({
          ident: `${ident(dir)}Http`,
          importPath: `../${dir}/http`,
          source: `feature:${dir}`,
        });
      }
    }

    // The Temporal facet (ADR-0008): temporal.ts is pure data (workflow type
    // names + schedules). workflows.ts is deliberately NOT imported — it may
    // only be loaded by the SDK's sandbox bundler via the generated barrel.
    // activities.ts IS imported (data-only, like api.ts) to collect export
    // names for the dup-activity validator.
    let hasTemporal = false;
    let hasActivities = false;
    if (existsSync(join(base, "temporal.ts"))) {
      const temporalMod = (await import(join(base, "temporal.ts"))) as Record<string, unknown>;
      for (const v of Object.values(temporalMod)) {
        if (!v || typeof v !== "object" || !(v as Record<symbol, unknown>)[TEMPORAL_FACET_BRAND]) {
          continue;
        }
        hasTemporal = true;
        const facet = v as TemporalFacet;
        if (!existsSync(join(base, "workflows.ts"))) {
          throw new Error(
            `features/${dir}/temporal.ts declares a Temporal facet but features/${dir}/workflows.ts does not exist`,
          );
        }
        const declaredTypes = new Set(facet.workflowTypes);
        for (const type of facet.workflowTypes) {
          workflowTypes.push({ type, source: `feature:${dir}` });
        }
        for (const s of facet.schedules) {
          if (!declaredTypes.has(s.workflowType)) {
            throw new Error(
              `features/${dir}/temporal.ts schedule '${s.id}' starts workflowType '${s.workflowType}' which is not in the facet's workflowTypes`,
            );
          }
          temporalSchedules.push({
            scheduleId: `app_${dir}_${s.id}`,
            workflowType: s.workflowType,
            cron: s.cron,
            timezone: s.timezone,
            argsJson: s.args === undefined ? undefined : JSON.stringify(s.args),
            timeout: s.timeout,
            catchupWindow: s.catchupWindow,
            source: `feature:${dir}`,
          });
        }
      }
      if (!hasTemporal) {
        throw new Error(`features/${dir}/temporal.ts exists but exports no defineTemporal() facet`);
      }
    }
    if (existsSync(join(base, "activities.ts"))) {
      if (!hasTemporal) {
        throw new Error(
          `features/${dir}/activities.ts exists without a features/${dir}/temporal.ts facet`,
        );
      }
      hasActivities = true;
      const activitiesMod = (await import(join(base, "activities.ts"))) as Record<string, unknown>;
      for (const [name, v] of Object.entries(activitiesMod)) {
        if (typeof v === "function") activities.push({ name, source: `feature:${dir}` });
      }
    }

    features.push({
      dir,
      id: m.id,
      guestExposed: Boolean(m.guestExposed),
      hasApi,
      hasSchema,
      hasJobs,
      hasHttp,
      hasDetail,
      hasTemporal,
      hasActivities,
    });
  }

  // Source B , the interim apps/api transitional home (S3 §D2): explicit,
  // greppable list OUTSIDE featureDirs(), deleted entry-by-entry as each fold
  // (F-booth/F-wakes) moves its facet into features/<id>/http.ts (Source A).
  for (const entry of INTERIM_HTTP_MODULES) {
    const httpMod = (await import(join(REPO_ROOT, entry.file))) as Record<string, unknown>;
    const routes = readHttpRoutes(httpMod, entry.source);
    httpRoutes.push(...routes);
    httpModules.push({ ident: entry.ident, importPath: entry.importPath, source: entry.source });
  }

  // Deterministic order so `bun run apps:gen` twice is byte-identical.
  httpModules.sort((a, b) =>
    a.source !== b.source
      ? a.source < b.source
        ? -1
        : 1
      : a.importPath < b.importPath
        ? -1
        : a.importPath > b.importPath
          ? 1
          : 0,
  );

  // Base (apps/api) schema tables ride in the dup-table check too, so a feature
  // can never silently re-declare a table that already lives in the base schema.
  const baseSchemaMod = (await import(BASE_SCHEMA)) as Record<string, unknown>;
  for (const name of tableNames(baseSchemaMod)) tables.push({ name, source: "base" });
  for (const name of Object.keys(baseSchemaMod)) {
    schemaExports.push({ name, source: "base" });
  }

  return {
    apps: featureApps,
    features,
    tables,
    schemaExports,
    routerKeys,
    jobs,
    httpRoutes,
    httpModules,
    workflowTypes,
    temporalSchedules,
    activities,
    tileViews,
  };
}
