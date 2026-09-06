import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserIdSchema } from "../../../../contracts";

const store = vi.hoisted(() => ({
  blockUser: vi.fn(),
  unblockUser: vi.fn(),
}));

vi.mock("../store", () => store);

import { api, type Env } from "../api";

function testApp() {
  const app = new Hono<Env>();
  app.use("/api/*", async (context, next) => {
    const user = UserIdSchema.safeParse(context.req.header("X-Test-User"));
    context.set("userId", user.success ? user.data : null);
    context.set("token", null);
    await next();
  });
  app.route("/api", api);
  return app;
}

describe("block route boundary", () => {
  beforeEach(() => {
    store.blockUser.mockReset().mockResolvedValue(undefined);
    store.unblockUser.mockReset().mockResolvedValue(undefined);
  });

  it("requires authentication and a bounded user identifier", async () => {
    const app = testApp();

    expect((await app.request("/api/me/blocks/usr_target", { method: "PUT" })).status).toBe(401);
    expect(
      (
        await app.request(`/api/me/blocks/usr_${"x".repeat(10_000)}`, {
          method: "PUT",
          headers: { "X-Test-User": "usr_actor" },
        })
      ).status,
    ).toBe(400);
    expect(store.blockUser).not.toHaveBeenCalled();
  });

  it("keeps block and unblock idempotent without revealing whether the target exists", async () => {
    const app = testApp();
    const headers = { "X-Test-User": "usr_actor" };

    for (const target of ["usr_target", "usr_doesnotexist"] as const) {
      const first = await app.request(`/api/me/blocks/${target}`, { method: "PUT", headers });
      const repeated = await app.request(`/api/me/blocks/${target}`, { method: "PUT", headers });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true });
      expect(repeated.status).toBe(200);

      const removed = await app.request(`/api/me/blocks/${target}`, { method: "DELETE", headers });
      const absent = await app.request(`/api/me/blocks/${target}`, { method: "DELETE", headers });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual({ ok: true });
      expect(absent.status).toBe(200);
    }

    expect(store.blockUser).toHaveBeenCalledTimes(4);
    expect(store.unblockUser).toHaveBeenCalledTimes(4);
  });
});
