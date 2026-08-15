import type { Context } from "hono";
import type { z } from "zod";

type ParsedJson<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: Response };

export async function parseRequestJson<Schema extends z.ZodType>(
  context: Context,
  schema: Schema,
): Promise<ParsedJson<z.output<Schema>>> {
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

export function parseRequestValue<Schema extends z.ZodType>(
  context: Context,
  schema: Schema,
  raw: unknown,
): ParsedJson<z.output<Schema>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: context.json({ error: "invalid_request" }, 400) };
  }
  return { ok: true, value: parsed.data };
}

export function errorDetails(error: unknown): { readonly name: string; readonly message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: String(error) };
}
