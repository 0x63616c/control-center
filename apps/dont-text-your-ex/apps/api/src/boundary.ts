import type { Context } from "hono";
import type { z } from "zod";

type ParsedJson<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

export async function parseRequestJson<T>(
  context: Context,
  schema: z.ZodType<T>,
): Promise<ParsedJson<T>> {
  let raw: unknown;
  try {
    raw = await context.req.json();
  } catch {
    return { ok: false, response: context.json({ error: "invalid_request" }, 400) };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: context.json({ error: "invalid_request" }, 400) };
  }
  return { ok: true, value: parsed.data };
}
