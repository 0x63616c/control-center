/**
 * The public GitHub webhook endpoint (#126).
 *
 * Contract, in order, and the order matters:
 *  1. Read RAW bytes — the signature is over the raw body, never re-serialised JSON.
 *  2. Verify the HMAC in constant time. Reject before touching the database.
 *  3. Insert keyed on the delivery id with `on conflict do nothing`, so GitHub's
 *     "Redeliver" button and any retry are idempotent for free.
 *  4. Return 204 immediately. GitHub times out at 10s and disables hooks that
 *     keep failing, so NO work happens inline — later dispatch reads the table.
 */
import { defineHttp } from "@app-kit";
import { getLogger } from "@www/logger";
import { config } from "./config";
import { db } from "./db";
import { incomingWebhook } from "./schema";
import { toDeliveryRow, verifySignature } from "./service";

export const routes = defineHttp([
  {
    method: "POST",
    path: "/hooks/github",
    match: "exact",
    handler: async (req: Request) => {
      const raw = new Uint8Array(await req.arrayBuffer());

      const rejection = verifySignature(
        raw,
        req.headers.get("x-hub-signature-256"),
        config.GITHUB_BOT_WEBHOOK_SECRET,
      );
      if (rejection) {
        // Deliberately terse and identical for every rejection reason: the
        // caller learns nothing about why, and nothing is persisted.
        getLogger().warn(
          { rejection, hookId: req.headers.get("x-github-hook-id") },
          "hooks: webhook rejected",
        );
        return new Response(null, { status: 401 });
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
      } catch {
        getLogger().warn("hooks: webhook body was not valid JSON");
        return new Response(null, { status: 400 });
      }

      const row = toDeliveryRow(
        {
          deliveryId: req.headers.get("x-github-delivery"),
          event: req.headers.get("x-github-event"),
          hookId: req.headers.get("x-github-hook-id"),
        },
        payload,
      );
      if (!row) {
        getLogger().warn("hooks: webhook missing X-GitHub-Delivery or X-GitHub-Event");
        return new Response(null, { status: 400 });
      }

      await db.insert(incomingWebhook).values(row).onConflictDoNothing();

      // Never the payload body — deliveries carry repo content and user data.
      getLogger().info(
        {
          event: row.event,
          action: row.action,
          deliveryId: row.deliveryId,
          repo: row.repo,
          sender: row.senderLogin,
          subjectNumber: row.subjectNumber,
        },
        "hooks: webhook received",
      );

      return new Response(null, { status: 204 });
    },
  },
]);
