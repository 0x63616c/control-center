import type { Pool } from "pg";

export interface SessionMaintenanceStore {
  purgeExpired(
    input: Readonly<{ now: number; limit: number }>,
  ): Promise<{ readonly deleted: number }>;
}

export function runSessionMaintenancePage(
  input: Readonly<{
    store: SessionMaintenanceStore;
    now: number;
    limit: number;
  }>,
): Promise<{ readonly deleted: number }> {
  return input.store.purgeExpired({ now: input.now, limit: input.limit });
}

export class PostgresSessionMaintenanceStore implements SessionMaintenanceStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async purgeExpired(
    input: Readonly<{ now: number; limit: number }>,
  ): Promise<{ deleted: number }> {
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT token FROM sessions
         WHERE expires_at <= $1
         ORDER BY expires_at, token
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       DELETE FROM sessions AS session
       USING expired
       WHERE session.token = expired.token`,
      [input.now, input.limit],
    );
    return { deleted: result.rowCount ?? 0 };
  }
}

export class MemorySessionMaintenanceStore implements SessionMaintenanceStore {
  readonly #sessions: Array<{ token: string; expiresAt: number }>;
  constructor(sessions: readonly { token: string; expiresAt: number }[] = []) {
    this.#sessions = sessions.map((session) => ({ ...session }));
  }
  async purgeExpired(
    input: Readonly<{ now: number; limit: number }>,
  ): Promise<{ deleted: number }> {
    const expired = this.#sessions
      .filter((session) => session.expiresAt <= input.now)
      .sort(
        (left, right) => left.expiresAt - right.expiresAt || left.token.localeCompare(right.token),
      )
      .slice(0, input.limit);
    const tokens = new Set(expired.map((session) => session.token));
    for (let index = this.#sessions.length - 1; index >= 0; index -= 1) {
      if (tokens.has(this.#sessions[index]?.token ?? "")) this.#sessions.splice(index, 1);
    }
    return { deleted: expired.length };
  }
  has(token: string): boolean {
    return this.#sessions.some((session) => session.token === token);
  }
}
