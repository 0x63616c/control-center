import { index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// Generic durable job queue (www-kp4k.12; relocated into @www/core at S1). Any
// background work that needs at-least-once delivery, per-attempt retry
// backoff, and a typed handler registry registers here. `notify` and
// `notify` is the current consumer; future async work (transcode,
// backups) registers a handler and gets retry + observability for free.
export const job = pgTable(
  "job",
  {
    id: serial("id").primaryKey(),
    // Stable string identifying the handler (e.g. 'notify').
    type: text("type").notNull(),
    // Arbitrary JSON input consumed by the handler, schema is handler-specific.
    payload: jsonb("payload").notNull(),
    // Lifecycle: queued → running → done | failed. A failed job that hasn't
    // exhausted its attempts is re-queued with an exponential run_after bump.
    status: text("status").notNull().default("queued"),
    // Higher priority = claimed first (ORDER BY priority DESC, created_at ASC).
    priority: integer("priority").notNull().default(0),
    // How many times the handler has been invoked (counting the current attempt).
    attempts: integer("attempts").notNull().default(0),
    // Maximum attempts before the job is permanently failed.
    maxAttempts: integer("max_attempts").notNull().default(5),
    // Not eligible for claiming until this wall-clock time. Default: now = immediately
    // claimable. Set forward by the retry logic for exponential backoff.
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    // Error message from the last failed attempt.
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Primary claim query: status=queued + type=<handler> + run_after<=now,
    // ordered by priority then arrival order. Every claim filters a single type,
    // and the reaper filters type + locked_at, so type leads run_after here. The
    // index lets the DB satisfy this in one scan rather than a heap filter sweep.
    index("job_claim_idx").on(t.status, t.type, t.runAfter, t.priority),
  ],
);
