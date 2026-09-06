import { describe, expect, it, vi } from "vitest";
import { privacySafeRequestPath } from "../request-log-path";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@www/logger", () => ({ createLogger: () => logger }));

import { buildApp } from "../server";

describe("privacy-safe request logging", () => {
  it.each([
    ["/api/me/blocks/usr_target-person", "/api/me/blocks/:userId"],
    ["/api/jars/jar_private/reports", "/api/jars/:id/reports"],
    ["/api/reports/rpt_private/resolve", "/api/reports/:id/resolve"],
    ["/api/unknown/private-value", "/api/unmatched"],
    ["/api/me", "/api/me"],
  ])("normalizes %s to %s", (path, expected) => {
    expect(privacySafeRequestPath(path)).toBe(expected);
  });

  it("never sends a block target user ID to the structured request logger", async () => {
    logger.info.mockClear();
    const targetUserId = "usr_target-must-not-reach-loki";

    const response = await buildApp().request(`/api/me/blocks/${targetUserId}`, {
      method: "PUT",
    });

    expect(response.status).toBe(401);
    const requestLog = logger.info.mock.calls.find((call) => call[1] === "request");
    expect(requestLog?.[0]).toMatchObject({
      method: "PUT",
      path: "/api/me/blocks/:userId",
      status: 401,
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(targetUserId);
  });
});
