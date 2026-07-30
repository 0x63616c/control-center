import { expect, it } from "vitest";
import { collect } from "../../../scripts/apps-gen/collect";
import { renderHttp, renderTiles } from "../../../scripts/apps-gen/emit";

// The determinism gate for the emitter (Task 3.3): renderTiles() over the real
// collected model must be stable across two calls, and the emitted apps must be
// sorted by id. This is what makes `bun run apps:gen` twice produce zero diff.
it("renders tiles sorted by id and is stable across two runs", async () => {
  const model = await collect();
  const a = renderTiles(model);
  const b = renderTiles(model);
  expect(a).toBe(b);
  const ids = [...a.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(ids).toEqual([...ids].sort());
});

// S3 codegen-level proof: renderHttp() emits real imports of the collected
// http facet modules, spread into GENERATED_ROUTES , the shape server.ts's
// findRoute iterates.
it("renders the wakes + booth feature http modules as an import barrel, stable across two runs", async () => {
  const model = await collect();
  const a = renderHttp(model);
  const b = renderHttp(model);
  expect(a).toBe(b);
  expect(a).toContain('import { routes as boothHttp } from "../booth/http";');
  expect(a).toContain('import { routes as wakesHttp } from "../wakes/http";');
  expect(a).toContain("...boothHttp");
  expect(a).toContain("...wakesHttp");
});
