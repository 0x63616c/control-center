import type { Context, Next } from "hono";
import { userIdForToken } from "./store";

// Pulls the bearer token, resolves the user, stashes it on context.
export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = token ? await userIdForToken(token) : null;
  c.set("userId", userId);
  c.set("token", token);
  await next();
}

// Guard for routes that require a logged-in user.
export function requireUser(c: Context): string | null {
  return (c.get("userId") as string | null) ?? null;
}
