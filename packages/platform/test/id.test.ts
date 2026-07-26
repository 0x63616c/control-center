import { describe, expect, test } from "vitest";
import { genId } from "../src/index.ts";

describe("genId", () => {
  test("mints a full-uuid id under the given prefix", () => {
    const id = genId("timer");
    expect(id).toMatch(/^timer_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("mints a truncated hex id when length is given", () => {
    const id = genId("wm", { length: 16 });
    expect(id).toMatch(/^wm_[0-9a-f]{16}$/);
  });

  test("never repeats across calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => genId("x", { length: 16 })));
    expect(ids.size).toBe(1000);
  });
});
