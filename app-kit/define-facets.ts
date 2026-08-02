// JobSpec is imported (not declared locally, unlike HttpRoute/CronSpec below):
// job specs are also consumed by `@www/core`'s runtime queue engine
// (`jobWorker`/`claimOne`), so the type lives with the engine, not the
// authoring surface. Re-exported here so feature authors and generated code
// can import every facet type from this one barrel.
import type { JobSpec } from "@www/core";

export const API_FACET_BRAND = Symbol.for("app-kit.api");
export const JOBS_FACET_BRAND = Symbol.for("app-kit.jobs");
export const HTTP_FACET_BRAND = Symbol.for("app-kit.http");
export const TEMPORAL_FACET_BRAND = Symbol.for("app-kit.temporal");
export const TILE_VIEWS_FACET_BRAND = Symbol.for("app-kit.tile-views");

export type { JobSpec };

/** The minimum Tile View declaration codegen needs to enforce App ownership. */
export interface TileViewDeclaration {
  readonly tileId: string;
}

/**
 * One raw (non-tRPC) HTTP route (S3). `handler` mirrors apps/api's `handle()`
 * shape exactly , raw bytes in via `req.arrayBuffer()`, a streamed/JSON
 * `Response` out, no tRPC context. CORS is overlaid centrally by the server
 * iterator (do NOT set CORS headers in the handler). `Request`/`Response`/`URL`
 * resolve here because the root tsconfig sets no `lib`, so TypeScript's
 * default DOM lib (implied by `target: ES2022`) is in scope at typecheck.
 */
export interface HttpRoute {
  /** Undefined = any method. Compared case-sensitively against `req.method`. */
  method?: string;
  /** Exact pathname (match "exact") or pathname prefix (match "prefix"). */
  path: string;
  /** Defaults to "exact". */
  match?: "exact" | "prefix";
  handler: (req: Request, url: URL) => Promise<Response>;
}

/**
 * One Temporal Schedule declared by a feature (ADR-0008). `id` is LOCAL to the
 * feature; codegen composes the full Temporal schedule ID as
 * `app_<feature-dir>_<id>`, which is also the marker the worker's boot-time
 * reconciler uses to recognise schedules it owns (and may delete when they
 * disappear from the facet). All fields are plain data — the facet is imported
 * by codegen under bun, so nothing here may touch `@temporalio/*`.
 */
export interface TemporalScheduleSpec {
  /** Local schedule id (kebab-case); full ID becomes `app_<feature-dir>_<id>`. */
  id: string;
  /**
   * The workflow type name to start — a STRING LITERAL matching a function
   * exported from the feature's `workflows.ts`, never `fn.name` (importing
   * workflows.ts here would drag `@temporalio/workflow` outside its sandbox).
   * Must appear in the facet's `workflowTypes`; a per-feature test should
   * assert literal and export agree (see features/temporal-health).
   */
  workflowType: string;
  /** Standard 5-field cron expression. */
  cron: string;
  /** IANA timezone the cron is evaluated in. Defaults to America/Los_Angeles. */
  timezone?: string;
  /** The workflow's single argument (one-arg-in convention), JSON-serialisable. */
  args?: unknown;
  /** workflowExecutionTimeout, e.g. "2 minutes". */
  timeout?: string;
  /** Catchup window for missed runs. Defaults to "1 minute". */
  catchupWindow?: string;
}

/**
 * The Temporal facet (`features/<id>/temporal.ts`, ADR-0008): pure DATA naming
 * the feature's workflow types and declaring its Schedules. The implementations
 * live in sibling files codegen never imports: `workflows.ts` (sandboxed,
 * reached only through the generated bundler entry) and `activities.ts`
 * (worker main thread — may use the db and `@www/core`).
 */
export interface TemporalFacet {
  /** Every workflow type `workflows.ts` exports, as string literals. */
  workflowTypes: readonly string[];
  schedules: readonly TemporalScheduleSpec[];
}

export function defineApi<T>(router: T): T {
  return brand(router, API_FACET_BRAND);
}
export function defineJobs(jobs: JobSpec[]): JobSpec[] {
  return brand(jobs, JOBS_FACET_BRAND);
}
export function defineHttp(routes: HttpRoute[]): HttpRoute[] {
  return brand(routes, HTTP_FACET_BRAND);
}
export function defineTemporal(facet: TemporalFacet): TemporalFacet {
  return brand(facet, TEMPORAL_FACET_BRAND);
}
export function defineTileViews<T extends TileViewDeclaration>(tileViews: T[]): T[] {
  return brand(tileViews, TILE_VIEWS_FACET_BRAND);
}

function brand<T>(v: T, sym: symbol): T {
  Object.defineProperty(v as object, sym, { value: true, enumerable: false });
  return v;
}
