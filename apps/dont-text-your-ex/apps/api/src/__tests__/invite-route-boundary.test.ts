import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserIdSchema } from "../../../../contracts";

const store = vi.hoisted(() => ({
  getJarPreviewByCode: vi.fn(),
  userIdForToken: vi.fn(),
}));

vi.mock("../store", () => store);

import { buildApp } from "../server";

describe("invite-code route boundary", () => {
  beforeEach(() => {
    store.getJarPreviewByCode.mockReset();
    store.userIdForToken.mockReset();
    store.userIdForToken.mockResolvedValue(UserIdSchema.parse("usr_routeboundary"));
    store.getJarPreviewByCode.mockResolvedValue(null);
  });

  it("rejects malformed route params before persistence", async () => {
    const response = await buildApp().request("/api/jars/code/not-valid!", {
      headers: { Authorization: "Bearer sess_routeboundary" },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(store.getJarPreviewByCode).not.toHaveBeenCalled();
  });

  it("normalizes a valid route param before persistence", async () => {
    const response = await buildApp().request("/api/jars/code/xex24k", {
      headers: { Authorization: "Bearer sess_routeboundary" },
    });

    expect(response.status).toBe(404);
    expect(store.getJarPreviewByCode).toHaveBeenCalledWith("XEX24K");
  });
});
