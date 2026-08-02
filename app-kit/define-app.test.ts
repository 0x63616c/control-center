import { expect, it } from "vitest";
import { APP_BRAND, defineApp } from "./define-app";
import {
  API_FACET_BRAND,
  defineApi,
  defineJobs,
  defineTemporal,
  defineWorkerCycles,
  JOBS_FACET_BRAND,
  TEMPORAL_FACET_BRAND,
  WORKER_CYCLES_FACET_BRAND,
} from "./define-facets";

const Dummy = () => null;

it("defineApp brands and passes through the manifest", () => {
  const m = defineApp({
    id: "demo",
    tiles: [
      { id: "demo", label: "Demo", component: Dummy, worldCol: 0, worldRow: 0, cols: 1, rows: 1 },
    ],
  });
  expect(m.id).toBe("demo");
  expect((m as Record<symbol, unknown>)[APP_BRAND]).toBe(true);
});

it("preserves the manifest-level private app gate", () => {
  const m = defineApp({
    id: "private-demo",
    private: true,
    tiles: [
      {
        id: "private-demo",
        label: "Demo",
        component: Dummy,
        worldCol: 0,
        worldRow: 0,
        cols: 1,
        rows: 1,
      },
    ],
  });
  expect(m.private).toBe(true);
});

it("supports multiple tiles per app, with home readable per-tile", () => {
  const m = defineApp({
    id: "demo",
    tiles: [
      {
        id: "demo_a",
        label: "A",
        component: Dummy,
        worldCol: 0,
        worldRow: 0,
        cols: 1,
        rows: 1,
        home: true,
      },
      { id: "demo_b", label: "B", component: Dummy, worldCol: 2, worldRow: 0, cols: 1, rows: 1 },
    ],
  });
  expect(m.tiles).toHaveLength(2);
  expect(m.tiles[0].home).toBe(true);
  expect(m.tiles[1].home).toBeUndefined();
});

it("facet wrappers brand their payload", () => {
  expect((defineApi({} as never) as Record<symbol, unknown>)[API_FACET_BRAND]).toBe(true);
  expect(
    (
      defineJobs([{ type: "demo_job" as never, handler: async () => {}, maxMs: 1000 }]) as Record<
        symbol,
        unknown
      >
    )[JOBS_FACET_BRAND],
  ).toBe(true);
  expect(
    (defineTemporal({ workflowTypes: ["DemoWorkflow"], schedules: [] }) as Record<symbol, unknown>)[
      TEMPORAL_FACET_BRAND
    ],
  ).toBe(true);
  expect(
    (
      defineWorkerCycles([
        { name: "demo-cycle", intervalMs: 1000, runOnStart: true, run: async () => {} },
      ]) as Record<symbol, unknown>
    )[WORKER_CYCLES_FACET_BRAND],
  ).toBe(true);
});
