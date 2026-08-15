import { z } from "zod";

export const AuthDevRequestSchema = z
  .object({
    as: z.enum(["new", "calum"]).optional(),
  })
  .strict();

export type AuthDevRequest = z.infer<typeof AuthDevRequestSchema>;
