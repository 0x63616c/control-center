const STATIC_API_PATHS = new Set([
  "/api/activity",
  "/api/auth/apple",
  "/api/auth/dev",
  "/api/auth/logout",
  "/api/health",
  "/api/jars",
  "/api/jars/join",
  "/api/jars/preview",
  "/api/me",
  "/api/me/blocks",
  "/api/me/notification-preferences",
  "/api/me/timezone",
  "/api/moderation/reports",
  "/api/push/devices",
  "/api/push/devices/disable",
  "/api/reports/history",
  "/api/reports/pending",
  "/api/rescue",
  "/api/test/reset",
]);

const DYNAMIC_API_PATHS: readonly Readonly<{
  pattern: RegExp;
  template: string;
}>[] = [
  { pattern: /^\/api\/me\/blocks\/[^/]+$/, template: "/api/me/blocks/:userId" },
  {
    pattern: /^\/api\/notifications\/[^/]+\/target$/,
    template: "/api/notifications/:id/target",
  },
  { pattern: /^\/api\/rescue\/[^/]+\/command$/, template: "/api/rescue/:id/command" },
  { pattern: /^\/api\/jars\/[^/]+$/, template: "/api/jars/:id" },
  { pattern: /^\/api\/jars\/[^/]+\/close$/, template: "/api/jars/:id/close" },
  {
    pattern: /^\/api\/jars\/[^/]+\/invite\/rotate$/,
    template: "/api/jars/:id/invite/rotate",
  },
  { pattern: /^\/api\/jars\/[^/]+\/leave$/, template: "/api/jars/:id/leave" },
  {
    pattern: /^\/api\/jars\/[^/]+\/share-streak$/,
    template: "/api/jars/:id/share-streak",
  },
  { pattern: /^\/api\/jars\/[^/]+\/slips$/, template: "/api/jars/:id/slips" },
  { pattern: /^\/api\/jars\/[^/]+\/reports$/, template: "/api/jars/:id/reports" },
  { pattern: /^\/api\/reports\/[^/]+$/, template: "/api/reports/:id" },
  { pattern: /^\/api\/reports\/[^/]+\/resolve$/, template: "/api/reports/:id/resolve" },
];

export function privacySafeRequestPath(path: string): string {
  if (STATIC_API_PATHS.has(path)) return path;
  for (const route of DYNAMIC_API_PATHS) {
    if (route.pattern.test(path)) return route.template;
  }
  return path.startsWith("/api/") ? "/api/unmatched" : "/unmatched";
}
