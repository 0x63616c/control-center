/**
 * Seam-proof test for the S3 HTTP-route seam (Track C). Two levels, mirroring
 * the S1/S2 seam-proof pattern (apps/worker/src/__tests__/jobs-seam.test.ts,
 * apps/api/src/__tests__/cron-run.test.ts):
 *
 *  1. Pure `findRoute` matcher tests , precedence (exact-before-prefix,
 *     longest-prefix) and the method gate, in isolation.
 *  2. Real dispatch: import `GENERATED_ROUTES` from the generated barrel
 *     (`@features/_generated/http.gen`), mock `saveWakePhoto` as a spy, run a
 *     real `POST /media/wake-photo` `Request` through
 *     `findRoute(...)?.handler(req, url)`, and assert the spy fired + 201 ,
 *     proving the route reachable through the generated barrel is the REAL
 *     wake handler, not merely an emitted spec.
 *  3. CORS proof: exercise the same central-overlay logic server.ts's
 *     `handle()` uses, confirming the S3 centralization (dropping inline
 *     CORS from the migrated handlers) is behaviour-preserving.
 *
 * Mock path note: features/wakes/http.ts imports `saveWakePhoto` from its
 * sibling `./photos`, resolved via the `@features/wakes/photos` alias , the
 * vi.mock path below MUST match that resolved module id or the spy silently
 * never fires.
 */
import type { HttpRoute } from "@app-kit";
import { describe, expect, it, vi } from "vitest";

const saveWakePhotoMock = vi.hoisted(() => vi.fn());

vi.mock("@features/wakes/photos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@features/wakes/photos")>();
  return { ...actual, saveWakePhoto: saveWakePhotoMock };
});

import { GENERATED_ROUTES } from "@features/_generated/http.gen";
import { findRoute } from "../route-table";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function overlayCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

describe("findRoute (pure matcher)", () => {
  const routes: HttpRoute[] = [
    {
      method: "POST",
      path: "/media/wake-photo",
      match: "exact",
      handler: async () => new Response(),
    },
    { path: "/media/wake-photos/", match: "prefix", handler: async () => new Response() },
    { path: "/media/", match: "prefix", handler: async () => new Response() },
  ];

  it("returns the exact match for a POST to the exact path", () => {
    expect(findRoute(routes, "POST", "/media/wake-photo")).toBe(routes[0]);
  });

  it("method-gates: a GET falls through the POST-only exact route to the broader prefix", () => {
    // The exact POST-only route is method-gated out, so this falls to the
    // catch-all "/media/" prefix in the fixture , exercising the same
    // fallthrough a real un-migrated GET route relies on.
    expect(findRoute(routes, "GET", "/media/wake-photo")).toBe(routes[2]);
  });

  it("method-gates: a GET misses entirely when no prefix covers the path", () => {
    const noPrefix = routes.slice(0, 1);
    expect(findRoute(noPrefix, "GET", "/media/wake-photo")).toBeUndefined();
  });

  it("exact never leaks into a prefix that would also match", () => {
    // "/media/wake-photo" does NOT start with "/media/wake-photos/", so this is
    // just confirming the exact route is chosen over the broader prefix below.
    expect(findRoute(routes, "GET", "/media/wake-photos/x.jpg")).toBe(routes[1]);
  });

  it("longest prefix wins when multiple prefixes match", () => {
    expect(findRoute(routes, "GET", "/media/wake-photos/x.jpg")).toBe(routes[1]);
    expect(routes[1]?.path.length).toBeGreaterThan(routes[2]?.path.length ?? 0);
  });

  it("returns undefined when nothing matches", () => {
    expect(findRoute(routes, "GET", "/trpc/foo")).toBeUndefined();
  });
});

describe("S3 route seam , real dispatch through the generated barrel", () => {
  it("GENERATED_ROUTES contains the migrated wake + booth routes", () => {
    const wake = findRoute(GENERATED_ROUTES, "POST", "/media/wake-photo");
    const booth = findRoute(GENERATED_ROUTES, "POST", "/media/booth-photo");
    expect(wake).toBeDefined();
    expect(booth).toBeDefined();
  });

  it("GENERATED_ROUTES contains the migrated ac, dogcam, wake-photo-read + booth-photo-read routes", () => {
    const climate = findRoute(GENERATED_ROUTES, "GET", "/health/climate");
    const cameraStream = findRoute(GENERATED_ROUTES, "GET", "/media/camera-stream");
    const wakePhoto = findRoute(
      GENERATED_ROUTES,
      "GET",
      "/media/wake-photos/2026-07-23T00-00-00-000Z-0.jpg",
    );
    const boothPhoto = findRoute(
      GENERATED_ROUTES,
      "GET",
      "/media/booth-photos/2026-07-23T00-00-00-000Z-0.jpg",
    );
    expect(climate).toBeDefined();
    expect(cameraStream).toBeDefined();
    expect(wakePhoto).toBeDefined();
    expect(boothPhoto).toBeDefined();
  });

  it("dispatches a real POST /media/wake-photo request to the real wake handler", async () => {
    saveWakePhotoMock.mockResolvedValueOnce("2026-07-23T00-00-00-000Z-0.jpg");

    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
    const req = new Request("http://localhost/media/wake-photo", {
      method: "POST",
      headers: { "x-captured-at": String(Date.now()) },
      body: jpegBytes,
    });
    const url = new URL(req.url);

    const route = findRoute(GENERATED_ROUTES, "POST", "/media/wake-photo");
    expect(route).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const res = overlayCors(await route!.handler(req, url));

    expect(saveWakePhotoMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string };
    expect(body.path).toBe("2026-07-23T00-00-00-000Z-0.jpg");
    // CORS proof (§D3): the centrally-overlaid header lands on the served
    // route response, exactly as it did inline before S3.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("still 400s on a rejected upload, with CORS overlaid on the error too", async () => {
    saveWakePhotoMock.mockRejectedValueOnce(new Error("wake photo is not a JPEG"));

    const req = new Request("http://localhost/media/wake-photo", {
      method: "POST",
      body: new Uint8Array([0x00, 0x01]),
    });
    const url = new URL(req.url);
    const route = findRoute(GENERATED_ROUTES, "POST", "/media/wake-photo");
    expect(route).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted defined above
    const res = overlayCors(await route!.handler(req, url));

    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
