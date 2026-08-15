import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

describe("frontend response JSON boundary", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a successful response that does not match its endpoint contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ id: "usr_wrong-domain" }])),
    );

    await expect(api.jars()).rejects.toThrow("invalid response for GET /jars");
  });

  it("does not expose an invalid error payload as trusted API detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 42 }), {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const request = api.me();
    await expect(request).rejects.toMatchObject({
      status: 400,
      message: "Bad Request",
      detail: undefined,
    });
  });
});
