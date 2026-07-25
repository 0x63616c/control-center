import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { createFeatureDb, MAX_POOL_CONNECTIONS } from "./pool";

describe("createFeatureDb", () => {
  it("memoizes the same URL to the same handle", () => {
    const url = "postgresql://user:pass@localhost:5432/one";
    const a = createFeatureDb(url, {});
    const b = createFeatureDb(url, {});
    expect(a).toBe(b);
  });

  it("gives different URLs different handles (different underlying pools)", () => {
    const a = createFeatureDb("postgresql://user:pass@localhost:5432/two", {});
    const b = createFeatureDb("postgresql://user:pass@localhost:5432/three", {});
    expect(a).not.toBe(b);
    expect(a.$client).not.toBe(b.$client);
  });

  it("exposes the underlying pg.Pool via $client with max set to MAX_POOL_CONNECTIONS", () => {
    const db = createFeatureDb("postgresql://user:pass@localhost:5432/four", {});
    expect(db.$client).toBeInstanceOf(Pool);
    expect(db.$client.options.max).toBe(MAX_POOL_CONNECTIONS);
  });
});
