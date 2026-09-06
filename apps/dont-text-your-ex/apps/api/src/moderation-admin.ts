import { genId } from "@www/platform";
import { z } from "zod";
import {
  type AbuseReportId,
  AbuseReportIdSchema,
  type JarId,
  JarIdSchema,
  type ReportId,
  ReportIdSchema,
  type UserId,
  UserIdSchema,
} from "../../../contracts";
import type { ModerationNarrativeCipher } from "./moderation";

export const MODERATION_OPERATOR_IDENTITY = "operator:calum-peter-webb" as const;
export const MODERATION_PRODUCTION_ACKNOWLEDGEMENT = "--acknowledge-production" as const;
export const MODERATION_STATUS = {
  Submitted: "submitted",
  Reviewing: "reviewing",
  Resolved: "resolved",
  Dismissed: "dismissed",
} as const;

type ModerationAdminDatabase = Readonly<{
  connect(): Promise<{
    query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    release(): void;
  }>;
}>;

const ModerationStatusSchema = z.enum(Object.values(MODERATION_STATUS));
const OpenModerationStatusSchema = z.union([
  z.literal(MODERATION_STATUS.Submitted),
  z.literal(MODERATION_STATUS.Reviewing),
]);
const ModerationTransitionStatusSchema = z.union([
  z.literal(MODERATION_STATUS.Reviewing),
  z.literal(MODERATION_STATUS.Resolved),
  z.literal(MODERATION_STATUS.Dismissed),
]);

export type ModerationStatus = z.infer<typeof ModerationStatusSchema>;
type OpenModerationStatus = z.infer<typeof OpenModerationStatusSchema>;
type ModerationTransitionStatus = z.infer<typeof ModerationTransitionStatusSchema>;

const ModerationQueueRowSchema = z.object({
  id: AbuseReportIdSchema,
  target_user_id: UserIdSchema.nullable(),
  status: OpenModerationStatusSchema,
  has_narrative: z.boolean(),
  referenced_jar_id: JarIdSchema.nullable(),
  referenced_gameplay_report_id: ReportIdSchema.nullable(),
  created_at: z.number(),
  updated_at: z.number(),
});

const ModerationReportRowSchema = z.object({
  id: AbuseReportIdSchema,
  reporter_user_id: UserIdSchema.nullable(),
  target_user_id: UserIdSchema.nullable(),
  narrative_ciphertext: z.string().nullable(),
  narrative_nonce: z.string().nullable(),
  narrative_key_version: z.string().nullable(),
  referenced_jar_id: JarIdSchema.nullable(),
  referenced_gameplay_report_id: ReportIdSchema.nullable(),
  status: ModerationStatusSchema,
  created_at: z.number(),
  updated_at: z.number(),
});

const ModerationAuditEventRowSchema = z.object({
  event_type: ModerationStatusSchema,
  actor_identity: z.string().nullable(),
  actor_user_id: UserIdSchema.nullable(),
  created_at: z.number(),
});

const ModerationTransitionRowSchema = z.object({
  status: ModerationStatusSchema,
  updated_at: z.number(),
});

export type ModerationQueueItem = Readonly<{
  reportId: AbuseReportId;
  targetUserId: UserId | null;
  status: OpenModerationStatus;
  hasNarrative: boolean;
  referencedJarId: JarId | null;
  referencedGameplayReportId: ReportId | null;
  createdAt: number;
  updatedAt: number;
}>;

export type ModerationReportDetail = Readonly<{
  reportId: AbuseReportId;
  reporterUserId: UserId | null;
  targetUserId: UserId | null;
  status: ModerationStatus;
  narrative: string | null;
  referencedJarId: JarId | null;
  referencedGameplayReportId: ReportId | null;
  createdAt: number;
  updatedAt: number;
  auditEvents: readonly Readonly<{
    eventType: ModerationStatus;
    actorIdentity: string | null;
    actorUserId: UserId | null;
    createdAt: number;
  }>[];
}>;

export interface ModerationAdminStore {
  listQueue(): Promise<readonly ModerationQueueItem[]>;
  show(reportId: AbuseReportId): Promise<ModerationReportDetail>;
  transition(
    reportId: AbuseReportId,
    status: ModerationTransitionStatus,
  ): Promise<{
    reportId: AbuseReportId;
    status: ModerationTransitionStatus;
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

function parseReportIdArgument(raw: unknown): AbuseReportId {
  const parsed = AbuseReportIdSchema.safeParse(raw);
  if (!parsed.success) throw new ModerationAdminCliError("invalid_report_id");
  return parsed.data;
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
    const reportId = parseReportIdArgument(args[1]);
    return { ok: true, command: "show", report: await input.store.show(reportId) };
  }
  if (args.length === 3 && args[0] === "transition") {
    const reportId = parseReportIdArgument(args[1]);
    const parsedStatus = ModerationTransitionStatusSchema.safeParse(args[2]);
    if (!parsedStatus.success) {
      throw new ModerationAdminCliError("invalid_status");
    }
    return {
      ok: true,
      command: "transition",
      ...(await input.store.transition(reportId, parsedStatus.data)),
    };
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
  assertModerationAdminRuntime(argv, env.isProduction() && env.isKubernetesRuntime());
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

export class PostgresModerationAdminStore implements ModerationAdminStore {
  constructor(
    private readonly database: ModerationAdminDatabase,
    private readonly narrativeCipher: ModerationNarrativeCipher,
    private readonly clock: () => number = Date.now,
  ) {}

  async listQueue(): Promise<readonly ModerationQueueItem[]> {
    const client = await this.database.connect();
    try {
      const result = await client.query(
        `SELECT id,target_user_id,status,
                (narrative_ciphertext IS NOT NULL) AS has_narrative,
                referenced_jar_id,referenced_gameplay_report_id,
                created_at::double precision AS created_at,
                updated_at::double precision AS updated_at
         FROM abuse_report
         WHERE status IN ('submitted','reviewing')
         ORDER BY created_at,id`,
      );
      return result.rows
        .map((rawRow) => ModerationQueueRowSchema.parse(rawRow))
        .map((row) => ({
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

  async show(reportId: AbuseReportId): Promise<ModerationReportDetail> {
    const client = await this.database.connect();
    try {
      const result = await client.query(
        `SELECT id,reporter_user_id,target_user_id,narrative_ciphertext,narrative_nonce,
                narrative_key_version,referenced_jar_id,referenced_gameplay_report_id,status,
                created_at::double precision AS created_at,
                updated_at::double precision AS updated_at
         FROM abuse_report WHERE id=$1`,
        [reportId],
      );
      const rawRow = result.rows[0];
      if (!rawRow) throw new ModerationAdminCliError("report_not_found");
      const row = ModerationReportRowSchema.parse(rawRow);
      const audit = await client.query(
        `SELECT event_type,actor_identity,actor_user_id,
                created_at::double precision AS created_at
         FROM abuse_report_audit_event
         WHERE abuse_report_id=$1 ORDER BY created_at,id`,
        [reportId],
      );
      const auditEvents = audit.rows.map((event) => ModerationAuditEventRowSchema.parse(event));
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
        auditEvents: auditEvents.map((event) => ({
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
    reportId: AbuseReportId,
    status: ModerationTransitionStatus,
  ): Promise<{
    reportId: AbuseReportId;
    status: ModerationTransitionStatus;
    changed: boolean;
  }> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query(
        `SELECT status,updated_at::double precision AS updated_at
         FROM abuse_report WHERE id=$1 FOR UPDATE`,
        [reportId],
      );
      const rawCurrent = selected.rows[0];
      if (!rawCurrent) throw new ModerationAdminCliError("report_not_found");
      const current = ModerationTransitionRowSchema.parse(rawCurrent);
      if (current.status === status) {
        await client.query("COMMIT");
        return { reportId, status, changed: false };
      }
      const valid =
        (current.status === MODERATION_STATUS.Submitted &&
          status === MODERATION_STATUS.Reviewing) ||
        (current.status === MODERATION_STATUS.Reviewing &&
          (status === MODERATION_STATUS.Resolved || status === MODERATION_STATUS.Dismissed));
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
