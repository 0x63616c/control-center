import { describe, expect, it } from "vitest";
import { classifyRateLimitRoute, rateLimitClasses } from "../../../../contracts/rate-limit-policy";

describe("shared edge and origin rate-limit route policy", () => {
  it.each([
    ["GET", "/api/me", null],
    ["POST", "/api/auth/apple", "auth"],
    ["POST", "/api/jars/join", "invite"],
    ["POST", "/api/jars/preview", "invite"],
    ["POST", "/api/jars/jar_one/reports", "reportEvidence"],
    ["POST", "/api/moderation/reports", "reportEvidence"],
    ["POST", "/api/reports/rpt_one/resolve", "reportEvidence"],
    ["PATCH", "/api/me", "reportEvidence"],
    ["POST", "/api/jars", "mutation"],
    ["DELETE", "/api/me/blocks/usr_one", "mutation"],
  ] as const)("classifies %s %s as %s", (method, path, expected) => {
    expect(classifyRateLimitRoute(method, path)).toBe(expected);
    expect(rateLimitClasses(method, path)).toEqual(
      expected === null ? ["general"] : ["general", expected],
    );
  });

  it("normalizes method casing before applying the shared mutation policy", () => {
    expect(classifyRateLimitRoute("post", "/api/jars")).toBe("mutation");
  });
});
