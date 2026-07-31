import { ENV } from "@www/platform/env";
import { z } from "zod";

const targetsSchema = z
  .array(z.object({ name: z.string().min(1), url: z.string().url() }))
  .min(1)
  .superRefine((targets, ctx) => {
    const names = new Set<string>();
    for (const target of targets) {
      if (names.has(target.name))
        ctx.addIssue({ code: "custom", message: `duplicate target name: ${target.name}` });
      names.add(target.name);
    }
  });
export type RelayTarget = Readonly<{ name: string; url: string }>;
export function relayConfig(): Readonly<{ secret: string; targets: readonly RelayTarget[] }> {
  return {
    secret: ENV.GITHUB_BOT_WEBHOOK_SECRET,
    targets: targetsSchema.parse(JSON.parse(ENV.WEBHOOK_RELAY_TARGETS)),
  };
}
