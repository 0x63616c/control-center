import { genId } from "@www/platform";
import type { Pool } from "pg";
import type { ModerationNarrativeCipher } from "./moderation";

export const MODERATION_OPERATOR_IDENTITY = "operator:calum-peter-webb" as const;
export const MODERATION_PRODUCTION_ACKNOWLEDGEMENT = "--acknowledge-production" as const;

export type ModerationStatus = "submitted" | "reviewing" | "resolved" | "dismissed";

export type ModerationQueueItem = Readonly<{
  reportId: string;
  targetUserId: string | null;
  status: "submitted" | "reviewing";
  hasNarrative: boolean;
  referencedJarId: string | null;
  referencedGameplayReportId: string | null;
  createdAt: number;
  updatedAt: number;
}>;

export type ModerationReportDetail = Readonly<{
  reportId: string;
  reporterUserId: string | null;
  targetUserId: string | null;
  status: ModerationStatus;
  narrative: string | null;
  referencedJarId: string | null;
  referencedGameplayReportId: string | null;
  createdAt: number;
  updatedAt: number;
  auditEvents: readonly Readonly<{
    eventType: ModerationStatus;
    actorIdentity: string | null;
    actorUserId: string | null;
    createdAt: number;
  }>[];
}>;

export interface ModerationAdminStore {
  listQueue(): Promise<readonly ModerationQueueItem[]>;
  show(reportId: string): Promise<ModerationReportDetail>;
  transition(
    reportId: string,
    status: Exclude<ModerationStatus, "submitted">,
  ): Promise<{
    reportId: string;
    status: Exclude<ModerationStatus, "submitted">;
    changed: boolean;
  }>;
}

export class ModerationAdminCliError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ModerationAdminCliError";
  }
}

function assertModerationAdminRuntime(argv: readonly string[], productionRuntime: boolean): void {
  if (!argv.includes(MODERATION_PRODUCTION_ACKNOWLEDGEMENT)) {
    throw new ModerationAdminCliError("production_acknowledgement_required");
  }
  if (!productionRuntime) {
    throw new ModerationAdminCliError("private_production_runtime_required");
  }
}

export async function executeModerationAdminCommand(input: {
  readonly argv: readonly string[];
  readonly productionRuntime: boolean;
  readonly store: ModerationAdminStore;
}): Promise<unknown> {
  assertModerationAdminRuntime(input.argv, input.productionRuntime);
  const args = input.argv.filter((argument) => argument !== MODERATION_PRODUCTION_ACKNOWLEDGEMENT);
  if (args.length === 1 && args[0] === "list") {
    return { ok: true, command: "list", reports: await input.store.listQueue() };
  }
  if (args.length === 2 && args[0] === "show") {
    const reportId = args[1] ?? "";
    if (!/^abr_[a-f0-9]{32}$/.test(reportId)) {
      throw new ModerationAdminCliError("invalid_report_id");
    }
    return { ok: true, command: "show", report: await input.store.show(reportId) };
  }
  if (args.length === 3 && args[0] === "transition") {
    const reportId = args[1] ?? "";
    if (!/^abr_[a-f0-9]{32}$/.test(reportId)) {
      throw new ModerationAdminCliError("invalid_report_id");
    }
    const status = args[2];
    if (status !== "reviewing" && status !== "resolved" && status !== "dismissed") {
      throw new ModerationAdminCliError("invalid_status");
    }
    return { ok: true, command: "transition", ...(await input.store.transition(reportId, status)) };
  }
  throw new ModerationAdminCliError("unsupported_command");
}

export async function runModerationAdminCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<unknown> {
  // Refuse before loading either secret. KUBERNETES_SERVICE_HOST is supplied by
  // Kubernetes; the production API pod is the only shipped image with both DB
  // credentials and the moderation keyring mounted.
  if (!argv.includes(MODERATION_PRODUCTION_ACKNOWLEDGEMENT)) {
    throw new ModerationAdminCliError("production_acknowledgement_required");
  }
  const env = await import("./env");
  assertModerationAdminRuntime(
    argv,
    env.isProduction() && Boolean(Bun.env.KUBERNETES_SERVICE_HOST),
  );
  const [{ pool }, moderation] = await Promise.all([import("./db/index"), import("./moderation")]);
  env.requireDatabaseUrl();
  const store = new PostgresModerationAdminStore(
    pool,
    moderation.createModerationNarrativeCipher(
      moderation.parseModerationNarrativeKeyring(env.moderationNarrativeKeyringSource()),
    ),
  );
  try {
    return await executeModerationAdminCommand({ argv, productionRuntime: true, store });
  } finally {
    await pool.end();
  }
}

// Concrete store and CLI entrypoint are added behind the command contract.
export class PostgresModerationAdminStore implements ModerationAdminStore {
  constructor(
    private readonly database: Pick<Pool, "connect">,
    private readonly narrativeCipher: ModerationNarrativeCipher,
    private readonly clock: () => number = Date.now,
  ) {}

  async listQueue(): Promise<readonly ModerationQueueItem[]> {
    const client = await this.database.connect();
    try {
      const result = await client.query<{
        id: string;
        target_user_id: string | null;
        status: "submitted" | "reviewing";
        has_narrative: boolean;
        referenced_jar_id: string | null;
        referenced_gameplay_report_id: string | null;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT id,target_user_id,status,
                (narrative_ciphertext IS NOT NULL) AS has_narrative,
                referenced_jar_id,referenced_gameplay_report_id,
                created_at::double precision AS created_at,
                updated_at::double precision AS updated_at
         FROM abuse_report
         WHERE status IN ('submitted','reviewing')
         ORDER BY created_at,id`,
      );
      return result.rows.map((row) => ({
        reportId: row.id,
        targetUserId: row.target_user_id,
        status: row.status,
        hasNarrative: row.has_narrative,
        referencedJarId: row.referenced_jar_id,
        referencedGameplayReportId: row.referenced_gameplay_report_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } finally {
      client.release();
    }
  }

  async show(reportId: string): Promise<ModerationReportDetail> {
    const client = await this.database.connect();
    try {
      const result = await client.query<{
        id: string;
        reporter_user_id: string | null;
        target_user_id: string | null;
        narrative_ciphertext: string | null;
        narrative_nonce: string | null;
        narrative_key_version: string | null;
        referenced_jar_id: string | null;
        referenced_gameplay_report_id: string | null;
        status: ModerationStatus;
        created_at: number;
        updated_at: number;
      }>(
        `SELECT id,reporter_user_id,target_user_id,narrative_ciphertext,narrative_nonce,
                narrative_key_version,referenced_jar_id,referenced_gameplay_report_id,status,
                created_at::double precision AS created_at,
                updated_at::double precision AS updated_at
         FROM abuse_report WHERE id=$1`,
        [reportId],
      );
      const row = result.rows[0];
      if (!row) throw new ModerationAdminCliError("report_not_found");
      const audit = await client.query<{
        event_type: ModerationStatus;
        actor_identity: string | null;
        actor_user_id: string | null;
        created_at: number;
      }>(
        `SELECT event_type,actor_identity,actor_user_id,
                created_at::double precision AS created_at
         FROM abuse_report_audit_event
         WHERE abuse_report_id=$1 ORDER BY created_at,id`,
        [reportId],
      );
      const narrative =
        row.narrative_ciphertext && row.narrative_nonce && row.narrative_key_version
          ? this.narrativeCipher.open(
              {
                ciphertext: row.narrative_ciphertext,
                nonce: row.narrative_nonce,
                keyVersion: row.narrative_key_version,
              },
              row.id,
            )
          : null;
      return {
        reportId: row.id,
        reporterUserId: row.reporter_user_id,
        targetUserId: row.target_user_id,
        status: row.status,
        narrative,
        referencedJarId: row.referenced_jar_id,
        referencedGameplayReportId: row.referenced_gameplay_report_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        auditEvents: audit.rows.map((event) => ({
          eventType: event.event_type,
          actorIdentity: event.actor_identity,
          actorUserId: event.actor_user_id,
          createdAt: event.created_at,
        })),
      };
    } finally {
      client.release();
    }
  }

  async transition(
    reportId: string,
    status: Exclude<ModerationStatus, "submitted">,
  ): Promise<{
    reportId: string;
    status: Exclude<ModerationStatus, "submitted">;
    changed: boolean;
  }> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        status: ModerationStatus;
        updated_at: number;
      }>(
        `SELECT status,updated_at::double precision AS updated_at
         FROM abuse_report WHERE id=$1 FOR UPDATE`,
        [reportId],
      );
      const current = selected.rows[0];
      if (!current) throw new ModerationAdminCliError("report_not_found");
      if (current.status === status) {
        await client.query("COMMIT");
        return { reportId, status, changed: false };
      }
      const valid =
        (current.status === "submitted" && status === "reviewing") ||
        (current.status === "reviewing" && (status === "resolved" || status === "dismissed"));
      if (!valid) throw new ModerationAdminCliError("invalid_status_transition");

      const changedAt = Math.max(this.clock(), current.updated_at + 1);
      await client.query("UPDATE abuse_report SET status=$2,updated_at=$3 WHERE id=$1", [
        reportId,
        status,
        changedAt,
      ]);
      await client.query(
        `INSERT INTO abuse_report_audit_event
           (id,abuse_report_id,event_type,actor_user_id,actor_identity,created_at)
         VALUES ($1,$2,$3,NULL,$4,$5)`,
        [genId("mae", { length: 32 }), reportId, status, MODERATION_OPERATOR_IDENTITY, changedAt],
      );
      await client.query("COMMIT");
      return { reportId, status, changed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

if (import.meta.main) {
  try {
    const output = await runModerationAdminCli();
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const code = error instanceof ModerationAdminCliError ? error.code : "moderation_admin_failed";
    process.stdout.write(`${JSON.stringify({ ok: false, error: code })}\n`);
    process.exitCode = 1;
  }
}
