export const RATE_LIMIT_CLASS = {
  General: "general",
  Auth: "auth",
  Invite: "invite",
  ReportEvidence: "reportEvidence",
  Mutation: "mutation",
} as const;

export type RateLimitClass = (typeof RATE_LIMIT_CLASS)[keyof typeof RATE_LIMIT_CLASS];
export type SpecificRateLimitClass = Exclude<RateLimitClass, "general">;

const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function classifyRateLimitRoute(
  method: string,
  path: string,
): SpecificRateLimitClass | null {
  const normalizedMethod = method.toUpperCase();
  if (path.startsWith("/api/auth/")) return RATE_LIMIT_CLASS.Auth;
  if (path === "/api/jars/join" || path === "/api/jars/preview") {
    return RATE_LIMIT_CLASS.Invite;
  }
  if (
    STATE_CHANGING_METHODS.has(normalizedMethod) &&
    (/^\/api\/jars\/[^/]+\/reports$/.test(path) ||
      path === "/api/moderation/reports" ||
      path.startsWith("/api/moderation/reports/") ||
      path.startsWith("/api/reports/") ||
      (normalizedMethod === "PATCH" && path === "/api/me"))
  ) {
    return RATE_LIMIT_CLASS.ReportEvidence;
  }
  return STATE_CHANGING_METHODS.has(normalizedMethod) ? RATE_LIMIT_CLASS.Mutation : null;
}

export function rateLimitClasses(method: string, path: string): readonly RateLimitClass[] {
  const specific = classifyRateLimitRoute(method, path);
  return specific ? [RATE_LIMIT_CLASS.General, specific] : [RATE_LIMIT_CLASS.General];
}
