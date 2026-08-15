import type { Context, Next } from "hono";
import { SessionTokenSchema } from "../../../contracts";
import type { Env } from "./api";
import { userIdForToken } from "./store";

// Pulls the bearer token, resolves the user, stashes it on context.
export async function authMiddleware(c: Context<Env>, next: Next) {
  const header = c.req.header("Authorization") ?? "";
  const parsed = SessionTokenSchema.safeParse(header.startsWith("Bearer ") ? header.slice(7) : "");
  const token = parsed.success ? parsed.data : null;
  const userId = token ? await userIdForToken(token) : null;
  c.set("userId", userId);
  c.set("token", token);
  await next();
}

// Guard for routes that require a logged-in user.
export function requireUser(c: Context<Env>) {
  return c.get("userId");
}
