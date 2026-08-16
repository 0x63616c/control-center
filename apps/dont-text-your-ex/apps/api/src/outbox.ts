import type { Pool } from "pg";
import { type DomainEvent, DomainEventSchema } from "./domain-events";

export type ClaimPageInput = Readonly<{
  owner: string;
  limit: number;
  now: number;
  leaseUntil: number;
}>;
type EventLeaseInput = Readonly<{
  eventId: DomainEvent["id"];
  owner: string;
  at: number;
}>;
export type RescheduleInput = EventLeaseInput & Readonly<{ availableAt: number; code: string }>;
export type MarkFailedInput = EventLeaseInput & Readonly<{ code: string }>;
export type RescheduleResult = Readonly<{
  status: "rescheduled" | "failed" | "not_owned";
}>;

export interface Outbox {
  claimPage(input: ClaimPageInput): Promise<readonly DomainEvent[]>;
  markAccepted(input: EventLeaseInput): Promise<boolean>;
  reschedule(input: RescheduleInput): Promise<RescheduleResult>;
  markFailed(input: MarkFailedInput): Promise<boolean>;
}

type MemoryEntry = {
  readonly event: DomainEvent;
  state: "pending" | "claimed" | "dispatched" | "failed";
  availableAt: number;
  claimOwner: string | null;
  claimExpiresAt: number | null;
  attemptCount: number;
};

export class MemoryOutbox implements Outbox {
  readonly #entries: MemoryEntry[];
  readonly #maxAttempts: number;

  constructor(
    events: readonly DomainEvent[] = [],
    options: Readonly<{ maxAttempts?: number }> = {},
  ) {
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#entries = events.map((event) => ({
      event,
      state: "pending",
      availableAt: event.occurredAt,
      claimOwner: null,
      claimExpiresAt: null,
      attemptCount: 0,
    }));
  }

  async claimPage(input: ClaimPageInput): Promise<readonly DomainEvent[]> {
    const candidates = this.#entries
      .filter(
        (entry) =>
          entry.availableAt <= input.now &&
          (entry.state === "pending" ||
            (entry.state === "claimed" && (entry.claimExpiresAt ?? 0) <= input.now)),
      )
      .sort(
        (left, right) =>
          left.event.occurredAt - right.event.occurredAt ||
          left.event.id.localeCompare(right.event.id),
      )
      .slice(0, input.limit);
    for (const entry of candidates) {
      entry.state = "claimed";
      entry.claimOwner = input.owner;
      entry.claimExpiresAt = input.leaseUntil;
      entry.attemptCount += 1;
    }
    return candidates.map((entry) => entry.event);
  }

  async markAccepted(input: EventLeaseInput): Promise<boolean> {
    const entry = this.#ownedEntry(input);
    if (!entry) return false;
    entry.state = "dispatched";
    entry.claimOwner = null;
    entry.claimExpiresAt = null;
    return true;
  }

  async reschedule(input: RescheduleInput): Promise<RescheduleResult> {
    const entry = this.#ownedEntry(input);
    if (!entry) return { status: "not_owned" };
    const failed = entry.attemptCount >= this.#maxAttempts;
    entry.state = failed ? "failed" : "pending";
    entry.availableAt = input.availableAt;
    entry.claimOwner = null;
    entry.claimExpiresAt = null;
    return { status: failed ? "failed" : "rescheduled" };
  }

  async markFailed(input: MarkFailedInput): Promise<boolean> {
    const entry = this.#ownedEntry(input);
    if (!entry) return false;
    entry.state = "failed";
    entry.claimOwner = null;
    entry.claimExpiresAt = null;
    return true;
  }

  #ownedEntry(input: EventLeaseInput): MemoryEntry | undefined {
    return this.#entries.find(
      (entry) =>
        entry.event.id === input.eventId &&
        entry.state === "claimed" &&
        entry.claimOwner === input.owner,
    );
  }
}

type DomainEventRow = {
  id: string;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  occurred_at: string;
};

function parseRow(row: DomainEventRow): DomainEvent {
  return DomainEventSchema.parse({
    id: row.id,
    type: row.event_type,
    schemaVersion: row.schema_version,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: Number(row.aggregate_version),
    occurredAt: Number(row.occurred_at),
  });
}

export class PostgresOutbox implements Outbox {
  readonly #pool: Pick<Pool, "connect" | "query">;
  readonly #maxAttempts: number;

  constructor(
    pool: Pick<Pool, "connect" | "query">,
    options: Readonly<{ maxAttempts?: number }> = {},
  ) {
    this.#pool = pool;
    this.#maxAttempts = options.maxAttempts ?? 10;
  }

  async claimPage(input: ClaimPageInput): Promise<readonly DomainEvent[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<DomainEventRow>(
        `WITH candidates AS (
           SELECT id FROM domain_event
           WHERE available_at <= $1
             AND (state = 'pending' OR (state = 'claimed' AND claim_expires_at <= $1))
           ORDER BY occurred_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
         )
         UPDATE domain_event AS event
         SET state='claimed', claim_owner=$3, claim_expires_at=$4,
             attempt_count=attempt_count+1, last_attempt_at=$1
         FROM candidates
         WHERE event.id=candidates.id
         RETURNING event.id, event.event_type, event.schema_version, event.aggregate_type,
                   event.aggregate_id, event.aggregate_version, event.occurred_at`,
        [input.now, input.limit, input.owner, input.leaseUntil],
      );
      await client.query("COMMIT");
      return rows
        .map(parseRow)
        .sort(
          (left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id),
        );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  markAccepted(input: EventLeaseInput): Promise<boolean> {
    return this.#finishLease(
      `UPDATE domain_event SET state='dispatched', dispatched_at=$3,
         claim_owner=NULL, claim_expires_at=NULL, last_error_code=NULL
       WHERE id=$1 AND state='claimed' AND claim_owner=$2`,
      [input.eventId, input.owner, input.at],
    );
  }

  async reschedule(input: RescheduleInput): Promise<RescheduleResult> {
    const result = await this.#pool.query<{ state: string }>(
      `UPDATE domain_event
       SET state=CASE WHEN attempt_count >= $5 THEN 'failed' ELSE 'pending' END,
           available_at=$3, last_error_code=$4,
           failed_at=CASE WHEN attempt_count >= $5 THEN $6 ELSE NULL END,
           claim_owner=NULL, claim_expires_at=NULL
       WHERE id=$1 AND state='claimed' AND claim_owner=$2
       RETURNING state`,
      [input.eventId, input.owner, input.availableAt, input.code, this.#maxAttempts, input.at],
    );
    const state = result.rows[0]?.state;
    if (state === "pending") return { status: "rescheduled" };
    if (state === "failed") return { status: "failed" };
    return { status: "not_owned" };
  }

  markFailed(input: MarkFailedInput): Promise<boolean> {
    return this.#finishLease(
      `UPDATE domain_event SET state='failed', failed_at=$3, last_error_code=$4,
         claim_owner=NULL, claim_expires_at=NULL
       WHERE id=$1 AND state='claimed' AND claim_owner=$2`,
      [input.eventId, input.owner, input.at, input.code],
    );
  }

  async #finishLease(query: string, values: unknown[]): Promise<boolean> {
    const result = await this.#pool.query(query, values);
    return (result.rowCount ?? 0) === 1;
  }
}
