/**
 * Incoming webhook deliveries (#126). Every delivery GitHub POSTs to
 * `hooks.worldwidewebb.co/hooks/github` is persisted here verbatim; nothing
 * dispatches off it yet. This table IS the seam later agent work reads from,
 * which is why the column set is deliberately wider than today's single
 * producer needs.
 *
 * Idempotency is structural, not defensive: `delivery_id` is GitHub's
 * `X-GitHub-Delivery` UUID and the primary key, so the "Redeliver" button and
 * any at-least-once retry collapse to `on conflict do nothing`.
 *
 * `source` exists so a future Linear / Sentry / Stripe hook lands here without a
 * migration — the expensive-to-change part of this design is the key choice and
 * the column set, not the handler.
 */
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const incomingWebhook = pgTable(
  "incoming_webhook",
  {
    // X-GitHub-Delivery. The idempotency key, hence the PK.
    deliveryId: text("delivery_id").primaryKey(),
    // 'github' today; the column is the multi-producer seam.
    source: text("source").notNull(),
    event: text("event").notNull(), // X-GitHub-Event
    action: text("action"), // payload.action
    repo: text("repo"), // payload.repository.full_name
    senderLogin: text("sender_login"),
    subjectType: text("subject_type"), // issue | pull_request | null
    subjectNumber: integer("subject_number"),
    installationId: text("installation_id"),
    hookId: text("hook_id"), // X-GitHub-Hook-ID
    // Always true today (rejects are refused before any insert). The column
    // keeps the option of recording rejects without a migration.
    signatureValid: boolean("signature_valid").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "What came in recently" is the default read.
    index("incoming_webhook_received_at_idx").on(t.receivedAt),
    // "Recent issues events" — the shape a dispatcher polls.
    index("incoming_webhook_event_received_at_idx").on(t.event, t.receivedAt),
    // "Everything that happened to issue #42".
    index("incoming_webhook_subject_idx").on(t.subjectType, t.subjectNumber),
  ],
);
