/**
 * The codegen consistency check (Track C Q7). Every App manifest and convention
 * facet is validated as one model before anything is emitted: duplicate ids,
 * App-local Tile View ownership, home-tile count, tile-rect overlap, and the
 * guestExposed flag agreeing with the reviewed
 * GUEST_EXPOSED allowlist (widening the guest surface is a deliberate,
 * security-reviewed edit to that allowlist, never an implicit flag flip).
 */
export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodegenError";
  }
}

interface Rect {
  worldCol: number;
  worldRow: number;
  cols: number;
  rows: number;
}
interface TileRect extends Rect {
  id: string;
  home?: boolean;
}
interface ValApp {
  id: string;
  featureDir: string;
  guestExposed?: boolean;
  sensitive?: boolean;
  private?: boolean;
  tiles: TileRect[];
}
interface Model {
  apps: ValApp[];
  /** Collected pgTable names (feature + base schema); a duplicate name is a fold error. */
  tables?: { name: string; source: string }[];
  /** Collected top-level tRPC router keys across features; a duplicate key is a fold error. */
  routerKeys?: { key: string; source: string }[];
  /** Collected `defineJobs` facet entries; a duplicate job type would let two
   *  features both claim the same queue rows. */
  jobs?: { type: string; source: string }[];
  /** App-owned interval workers. Names are runtime stats keys and must be globally unique. */
  workerCycles?: { name: string; source: string }[];
  /** Collected `defineHttp` routes; two routes with the same method+match+path
   *  would shadow each other in the generated route table. */
  httpRoutes?: { method?: string; path: string; match: string; source: string }[];
  /** Collected workflow type names off `defineTemporal` facets (ADR-0008); a
   *  duplicate type would be ambiguous on the shared task queue AND collide in
   *  the generated workflows barrel (`export *` re-exports). */
  workflowTypes?: { type: string; source: string }[];
  /** Collected Temporal schedule IDs (already `app_<dir>_<id>`-composed); a
   *  duplicate would make two features fight over one Schedule on every boot. */
  temporalSchedules?: { scheduleId: string; source: string }[];
  /** Collected activity export names; GENERATED_ACTIVITIES is one merged
   *  object, so a duplicate name silently last-write-wins. */
  activities?: { name: string; source: string }[];
  /** Collected named exports off every schema.ts module (feature + base);
   *  schema.gen.ts is a flat `export *` barrel, so a duplicate export name
   *  across two schema.ts files would silently last-write-win in the barrel. */
  schemaExports?: { name: string; source: string }[];
  /** App-owned Tile View declarations, one for every board Tile. */
  tileViews: { tileId: string; source: string }[];
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.worldCol < b.worldCol + b.cols &&
    a.worldCol + a.cols > b.worldCol &&
    a.worldRow < b.worldRow + b.rows &&
    a.worldRow + a.rows > b.worldRow
  );
}

/** @public consumed by the codegen emitter (Task 3.3), not yet built. */
export function validate(model: Model, guestExposed: readonly string[]): void {
  const allow = new Set(guestExposed);
  const seen = new Set<string>();

  // Duplicate table name across the union of feature schemas + the base
  // apps/api schema. Two tables with the same SQL name would make the generated
  // schema barrel ambiguous (and silently drop one from drizzle's migration
  // diff), so this is a hard fold error.
  if (model.tables) {
    const seenTable = new Map<string, string>();
    for (const t of model.tables) {
      const prev = seenTable.get(t.name);
      if (prev) {
        throw new CodegenError(
          `duplicate table name '${t.name}' (declared by ${prev} and ${t.source}) — a folded feature must not re-declare a table`,
        );
      }
      seenTable.set(t.name, t.source);
    }
  }

  // Duplicate top-level router key across features. Two features exposing the
  // same namespace (e.g. both `portal`) would collide when merged into the app
  // router, so reject it before emit.
  if (model.routerKeys) {
    const seenKey = new Map<string, string>();
    for (const r of model.routerKeys) {
      const prev = seenKey.get(r.key);
      if (prev) {
        throw new CodegenError(
          `duplicate router key '${r.key}' (exposed by ${prev} and ${r.source}) — two features cannot mount the same tRPC namespace`,
        );
      }
      seenKey.set(r.key, r.source);
    }
  }

  // Duplicate job type across features. Two features registering the same
  // `type` would both be claimed against by the worker's single generic drain,
  // so this is a hard fold error (mirrors the dup table / router-key checks).
  if (model.jobs) {
    const seenJob = new Map<string, string>();
    for (const j of model.jobs) {
      const prev = seenJob.get(j.type);
      if (prev) {
        throw new CodegenError(
          `duplicate job type '${j.type}' (declared by ${prev} and ${j.source}) — two features cannot register the same worker job type`,
        );
      }
      seenJob.set(j.type, j.source);
    }
  }

  if (model.workerCycles) {
    const seenCycle = new Map<string, string>();
    for (const cycle of model.workerCycles) {
      const prev = seenCycle.get(cycle.name);
      if (prev) {
        throw new CodegenError(
          `duplicate worker cycle name '${cycle.name}' (declared by ${prev} and ${cycle.source}) — worker cycle names are global runtime keys`,
        );
      }
      seenCycle.set(cycle.name, cycle.source);
    }
  }

  // Duplicate HTTP route across features/the interim apps/api list. Two routes
  // with the same method+match+path would shadow each other in the generated
  // route table (findRoute returns whichever happens to sort first), so this is
  // a hard fold error (mirrors the dup table/router-key/job checks).
  if (model.httpRoutes) {
    const seenRoute = new Map<string, string>();
    for (const r of model.httpRoutes) {
      const key = `${r.method ?? "*"} ${r.match} ${r.path}`;
      const prev = seenRoute.get(key);
      if (prev) {
        throw new CodegenError(
          `duplicate http route '${key}' (declared by ${prev} and ${r.source}) — two routes cannot shadow each other in the generated route table`,
        );
      }
      seenRoute.set(key, r.source);
    }
  }

  // Duplicate Temporal workflow type across features (ADR-0008). Two features
  // exporting the same workflow type would collide in the generated `export *`
  // workflows barrel and be ambiguous to start on the shared task queue.
  if (model.workflowTypes) {
    const seenWf = new Map<string, string>();
    for (const w of model.workflowTypes) {
      const prev = seenWf.get(w.type);
      if (prev) {
        throw new CodegenError(
          `duplicate workflow type '${w.type}' (declared by ${prev} and ${w.source}) — two features cannot export the same Temporal workflow type`,
        );
      }
      seenWf.set(w.type, w.source);
    }
  }

  // Duplicate Temporal schedule ID. IDs are already feature-prefixed
  // (`app_<dir>_<id>`), so a duplicate means one feature declared the same
  // local id twice.
  if (model.temporalSchedules) {
    const seenSched = new Map<string, string>();
    for (const s of model.temporalSchedules) {
      const prev = seenSched.get(s.scheduleId);
      if (prev) {
        throw new CodegenError(
          `duplicate Temporal schedule id '${s.scheduleId}' (declared by ${prev} and ${s.source})`,
        );
      }
      seenSched.set(s.scheduleId, s.source);
    }
  }

  // Duplicate activity export name across features. GENERATED_ACTIVITIES is one
  // merged object handed to the Temporal Worker, so a duplicate would silently
  // last-write-win (mirrors the schema-export barrel check).
  if (model.activities) {
    const seenAct = new Map<string, string>();
    for (const a of model.activities) {
      const prev = seenAct.get(a.name);
      if (prev) {
        throw new CodegenError(
          `duplicate activity export '${a.name}' (declared by ${prev} and ${a.source}) — two features cannot export the same activity name`,
        );
      }
      seenAct.set(a.name, a.source);
    }
  }

  // Duplicate export symbol across every schema.ts module (feature + base).
  // schema.gen.ts is a flat `export *` barrel across all of these, so two
  // schema.ts files exporting the same symbol name would silently
  // last-write-win in the generated barrel — a hard fold error (mirrors the
  // dup table/router-key/job/http-route checks).
  if (model.schemaExports) {
    const seenExport = new Map<string, string>();
    for (const e of model.schemaExports) {
      const prev = seenExport.get(e.name);
      if (prev) {
        throw new CodegenError(
          `duplicate schema export '${e.name}' (declared by ${prev} and ${e.source}) — two schema.ts files cannot export the same symbol name`,
        );
      }
      seenExport.set(e.name, e.source);
    }
  }

  for (const a of model.apps) {
    if (seen.has(a.id)) throw new CodegenError(`duplicate app id: ${a.id}`);
    seen.add(a.id);
    if (a.sensitive && a.private) {
      throw new CodegenError(`app ${a.id} cannot be both sensitive and private`);
    }
    const inAllow = allow.has(a.id);
    if (Boolean(a.guestExposed) !== inAllow) {
      throw new CodegenError(
        `app ${a.id}: guestExposed=${Boolean(a.guestExposed)} but GUEST_EXPOSED allowlist ${
          inAllow ? "contains" : "omits"
        } it — widening the guest surface needs an explicit, security-reviewed edit to the allowlist`,
      );
    }
  }

  // Flatten to all tiles of all apps.
  const tiles = model.apps.flatMap((a) => a.tiles.map((t) => ({ ...t, appId: a.id })));

  // Duplicate TILE id across every tile of every app (board / DB placement key
  // on this — a multi-tile app's tiles each need their own id).
  const seenTile = new Map<string, string>();
  for (const t of tiles) {
    const prev = seenTile.get(t.id);
    if (prev) {
      throw new CodegenError(
        `duplicate tile id '${t.id}' (declared by app ${prev} and app ${t.appId})`,
      );
    }
    seenTile.set(t.id, t.appId);
  }

  const declaredByTile = new Map<string, string>();
  for (const view of model.tileViews) {
    const previous = declaredByTile.get(view.tileId);
    if (previous) {
      throw new CodegenError(
        `duplicate Tile View for '${view.tileId}' (declared by ${previous} and ${view.source})`,
      );
    }
    declaredByTile.set(view.tileId, view.source);
  }
  const ownerByTile = new Map(
    model.apps.flatMap((app) =>
      app.tiles.map((tile) => [tile.id, `feature:${app.featureDir}`] as const),
    ),
  );
  for (const view of model.tileViews) {
    const owner = ownerByTile.get(view.tileId);
    if (!owner) {
      throw new CodegenError(
        `Tile View '${view.tileId}' from ${view.source} does not belong to a declared Tile`,
      );
    }
    if (view.source !== owner) {
      throw new CodegenError(`Tile View '${view.tileId}' belongs to ${owner}, not ${view.source}`);
    }
  }
  for (const tile of tiles) {
    if (!declaredByTile.has(tile.id)) {
      throw new CodegenError(`missing Tile View for '${tile.id}'`);
    }
  }

  // Exactly one home tile across ALL tiles of ALL apps.
  const homes = tiles.filter((t) => t.home).length;
  if (homes !== 1) throw new CodegenError(`expected exactly one home tile, found ${homes}`);

  // No tile-rect overlap across every pair of tiles, including two tiles owned
  // by the same app (a multi-tile app must not self-overlap).
  for (let i = 0; i < tiles.length; i++)
    for (let j = i + 1; j < tiles.length; j++)
      if (overlaps(tiles[i], tiles[j]))
        throw new CodegenError(`tiles ${tiles[i].id} and ${tiles[j].id} overlap`);
}
