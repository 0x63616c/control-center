import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JarIdSchema, ReportIdSchema } from "../../../contracts";
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

  it("routes branded jar and report identifiers to their matching resources", async () => {
    const fetchMock = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.jar(JarIdSchema.parse("jar_123"))).rejects.toThrow(
      "invalid response for GET /jars/jar_123",
    );
    await expect(api.resolveReport(ReportIdSchema.parse("rpt_123"), "deny")).rejects.toThrow(
      "invalid response for POST /reports/rpt_123/resolve",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/jars/jar_123",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/reports/rpt_123/resolve",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
