import type { Pool, PoolClient } from "pg";
import {
  type DomainEvent,
  DomainEventSchema,
  domainEventDefinition,
  type NewDomainEvent,
} from "./domain-events";
import { id } from "./ids";

export interface PostCommitEventNudge {
  nudge(eventIds: readonly DomainEvent["id"][]): Promise<void>;
}

class NoopPostCommitNudge implements PostCommitEventNudge {
  async nudge(): Promise<void> {}
}

export class RecordingPostCommitNudge implements PostCommitEventNudge {
  readonly #calls: Array<readonly DomainEvent["id"][]> = [];

  async nudge(eventIds: readonly DomainEvent["id"][]): Promise<void> {
    this.#calls.push([...eventIds]);
  }

  calls(): readonly (readonly DomainEvent["id"][])[] {
    return this.#calls.map((call) => [...call]);
  }
}

export type DomainTransactionContext = Readonly<{
  db: PoolClient;
  emit(event: NewDomainEvent): Promise<DomainEvent>;
}>;

export class AmbiguousDomainTransactionError extends Error {
  constructor(cause: unknown, rollbackFailure?: unknown) {
    super("database transaction outcome is ambiguous", { cause });
    this.name = "AmbiguousDomainTransactionError";
    if (rollbackFailure !== undefined) {
      Object.defineProperty(this, "rollbackFailure", {
        value: rollbackFailure,
        enumerable: false,
      });
    }
  }
}

type DomainTransactionRunnerOptions = Readonly<{
  pool: Pick<Pool, "connect">;
  nudge?: PostCommitEventNudge;
  clock?: () => number;
  nudgeTimeoutMs?: number;
}>;

export class DomainTransactionRunner {
  readonly #pool: Pick<Pool, "connect">;
  readonly #nudge: PostCommitEventNudge;
  readonly #clock: () => number;
  readonly #nudgeTimeoutMs: number;

  constructor(options: DomainTransactionRunnerOptions) {
    this.#pool = options.pool;
    this.#nudge = options.nudge ?? new NoopPostCommitNudge();
    this.#clock = options.clock ?? Date.now;
    this.#nudgeTimeoutMs = options.nudgeTimeoutMs ?? 100;
  }

  async run<T>(operation: (context: DomainTransactionContext) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    const eventIds: DomainEvent["id"][] = [];
    let commitAttempted = false;
    try {
      await client.query("BEGIN");
      const value = await operation({
        db: client,
        emit: async (event) => {
          const definition = domainEventDefinition(event.type);
          const occurredAt = this.#clock();
          const persisted = DomainEventSchema.parse({
            id: id("evt"),
            type: event.type,
            schemaVersion: definition.schemaVersion,
            aggregateType: definition.aggregateType,
            aggregateId: event.aggregateId,
            aggregateVersion: event.aggregateVersion,
            occurredAt,
          });
          await client.query(
            `INSERT INTO domain_event
               (id, event_type, schema_version, aggregate_type, aggregate_id,
                aggregate_version, occurred_at, available_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
            [
              persisted.id,
              persisted.type,
              persisted.schemaVersion,
              persisted.aggregateType,
              persisted.aggregateId,
              persisted.aggregateVersion,
              persisted.occurredAt,
            ],
          );
          eventIds.push(persisted.id);
          return persisted;
        },
      });
      commitAttempted = true;
      await client.query("COMMIT");
      await this.#boundedNudge(eventIds);
      return value;
    } catch (error) {
      let rollbackFailure: unknown;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
      if (commitAttempted || rollbackFailure !== undefined) {
        throw new AmbiguousDomainTransactionError(error, rollbackFailure);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async #boundedNudge(eventIds: readonly DomainEvent["id"][]): Promise<void> {
    if (eventIds.length === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#nudge.nudge(eventIds),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.#nudgeTimeoutMs);
        }),
      ]);
    } catch {
      // The committed outbox is authoritative; scheduled recovery retries it.
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
