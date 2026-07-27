import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// These assertions are about the vendored JSON itself, not about Pulumi. Every
// one of them encodes a way a dashboard has silently rendered blank before:
// a foreign datasource uid, an angular panel type Grafana no longer ships, a
// duplicate uid shadowing another dashboard.
const DASHBOARD_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "observability",
  "dashboards",
);

type Json = Record<string, unknown>;

const files = readdirSync(DASHBOARD_DIR)
  .filter((f) => f.toLowerCase().endsWith(".json"))
  .sort();

const dashboards = files.map((file) => ({
  file,
  json: JSON.parse(readFileSync(join(DASHBOARD_DIR, file), "utf8")) as Json,
}));

/** Every object nested anywhere in the dashboard, including collapsed rows. */
function everyObject(node: unknown): Json[] {
  if (Array.isArray(node)) return node.flatMap(everyObject);
  if (node && typeof node === "object") {
    return [node as Json, ...Object.values(node as Json).flatMap(everyObject)];
  }
  return [];
}

describe("vendored Grafana dashboards (#175, #210)", () => {
  test("there is at least one dashboard, so the checks below are not vacuous", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(dashboards)("$file has a stable www- uid and a title", ({ json }) => {
    expect(json.uid).toMatch(/^www-[a-z0-9-]+$/);
    expect(json.title).toBeTypeOf("string");
    expect((json.title as string).length).toBeGreaterThan(0);
  });

  test("uids and titles are unique — a duplicate uid makes one dashboard shadow the other", () => {
    const uids = dashboards.map((d) => d.json.uid);
    const titles = dashboards.map((d) => d.json.title);
    expect(new Set(uids).size).toBe(uids.length);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test.each(dashboards)("$file references only this stack's datasources", ({ json }) => {
    for (const obj of everyObject(json)) {
      const ds = obj.datasource;
      if (ds === undefined || ds === null) continue;
      // Grafana's built-in annotation datasource is named, not uid'd.
      if (typeof ds === "string") {
        expect(ds).toBe("-- Grafana --");
        continue;
      }
      const uid = (ds as Json).uid;
      if (uid === "grafana" || uid === "-- Grafana --") continue;
      expect(uid).toMatch(/^www-(prometheus|loki)$/);
    }
  });

  test.each(dashboards)("$file has no angular panels — Grafana 12 removed angular", ({ json }) => {
    const dead = new Set(["graph", "singlestat", "table-old", "grafana-piechart-panel"]);
    const types = everyObject(json)
      .filter((o) => typeof o.type === "string" && Array.isArray(o.targets ?? o.panels))
      .map((o) => o.type as string);
    expect(types.filter((t) => dead.has(t))).toEqual([]);
  });

  test.each(dashboards)("$file carries no import-flow blocks or blank queries", ({ json }) => {
    // `__inputs`/`__requires` drive the UI import wizard; file provisioning
    // never resolves them, so any `${DS_*}` left behind renders "not found".
    expect(json.__inputs).toBeUndefined();
    expect(json.__requires).toBeUndefined();

    for (const obj of everyObject(json)) {
      if (!Array.isArray(obj.targets)) continue;
      const exprs = (obj.targets as Json[])
        .filter((t) => t && typeof t === "object")
        .map((t) => t.expr)
        .filter((e): e is string => typeof e === "string");
      if (exprs.length === 0) continue;
      expect(exprs.some((e) => e.trim().length > 0)).toBe(true);
    }
  });

  test.each(dashboards)("$file fits in a ConfigMap", ({ file }) => {
    // etcd caps a ConfigMap at ~1 MiB; one dashboard per ConfigMap keeps this
    // per-file, and this is the guard that says so out loud.
    expect(statSync(join(DASHBOARD_DIR, file)).size).toBeLessThan(900 * 1024);
  });
});
