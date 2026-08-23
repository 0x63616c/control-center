import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { genId } from "@www/platform";
import type { Pool } from "pg";
import { z } from "zod";
import {
  AbuseReportIdSchema,
  AbuseReportReceiptSchema,
  type CreateAbuseReportRequest,
  type UserId,
} from "../../../contracts";

export class ModerationAuthorizationError extends Error {
  constructor() {
    super("moderation target or reference is not available to this user");
    this.name = "ModerationAuthorizationError";
  }
}

type ModerationPool = Pick<Pool, "connect">;

const encryptionKeySchema = z
  .string()
  .base64()
  .transform((value, ctx) => {
    const key = Buffer.from(value, "base64");
    if (key.length !== 32) {
      ctx.addIssue({ code: "custom", message: "moderation narrative keys must be 32 bytes" });
      return z.NEVER;
    }
    return key;
  });

const narrativeKeyringSchema = z
  .object({
    activeKeyId: z.string().min(1),
    keys: z.record(z.string(), encryptionKeySchema),
  })
  .strict();

export type ModerationNarrativeKeyring = Readonly<{
  activeKeyId: string;
  keys: Readonly<Record<string, Buffer>>;
}>;

type SealedModerationNarrative = Readonly<{
  ciphertext: string;
  nonce: string;
  keyVersion: string;
}>;

export interface ModerationNarrativeCipher {
  seal(narrative: string, reportId: string): SealedModerationNarrative;
  open(sealed: SealedModerationNarrative, reportId: string): string;
}

export function parseModerationNarrativeKeyring(input: unknown): ModerationNarrativeKeyring {
  const parsed = narrativeKeyringSchema.parse(input);
  if (!parsed.keys[parsed.activeKeyId])
    throw new Error("active moderation narrative key is missing");
  return parsed;
}

export function createModerationNarrativeCipher(
  keyring: ModerationNarrativeKeyring,
): ModerationNarrativeCipher {
  return {
    seal(narrative, reportId) {
      const key = keyring.keys[keyring.activeKeyId];
      if (!key) throw new Error("active moderation narrative key is missing");
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(reportId, "utf8"));
      const body = Buffer.concat([cipher.update(narrative, "utf8"), cipher.final()]);
      return {
        ciphertext: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
        nonce: nonce.toString("base64"),
        keyVersion: keyring.activeKeyId,
      };
    },
    open(sealed, reportId) {
      const key = keyring.keys[sealed.keyVersion];
      if (!key) throw new Error("moderation narrative key version is unavailable");
      const nonce = Buffer.from(sealed.nonce, "base64");
      const encrypted = Buffer.from(sealed.ciphertext, "base64");
      if (nonce.length !== 12 || encrypted.length <= 16) {
        throw new Error("moderation narrative envelope is invalid");
      }
      const body = encrypted.subarray(0, encrypted.length - 16);
      const authTag = encrypted.subarray(encrypted.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.from(reportId, "utf8"));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    },
  };
}

export interface ModerationSubmissionStore {
  submit(
    reporterUserId: UserId,
    report: CreateAbuseReportRequest,
  ): Promise<ReturnType<typeof AbuseReportReceiptSchema.parse>>;
}

export class PostgresModerationStore {
  constructor(
    private readonly database: ModerationPool,
    private readonly narrativeCipher: ModerationNarrativeCipher,
    private readonly clock: () => number = Date.now,
  ) {}

  async submit(
    reporterUserId: UserId,
    report: CreateAbuseReportRequest,
  ): Promise<ReturnType<typeof AbuseReportReceiptSchema.parse>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const related = await client.query(
        `SELECT 1
         FROM memberships reporter
         JOIN memberships target ON target.jar_id=reporter.jar_id
         WHERE reporter.user_id=$1 AND target.user_id=$2
           AND reporter.left_at IS NULL AND target.left_at IS NULL
         LIMIT 1`,
        [reporterUserId, report.targetUserId],
      );
      if (related.rowCount !== 1) throw new ModerationAuthorizationError();

      if (report.reference?.jarId) {
        const visibleJar = await client.query(
          `SELECT 1
           FROM memberships reporter
           JOIN memberships target ON target.jar_id=reporter.jar_id
           WHERE reporter.jar_id=$1 AND reporter.user_id=$2 AND target.user_id=$3
             AND reporter.left_at IS NULL AND target.left_at IS NULL`,
          [report.reference.jarId, reporterUserId, report.targetUserId],
        );
        if (visibleJar.rowCount !== 1) throw new ModerationAuthorizationError();
      }

      if (report.reference?.gameplayReportId) {
        const visibleGameplayReport = await client.query<{ jar_id: string }>(
          `SELECT gameplay.jar_id
           FROM reports gameplay
           JOIN memberships viewer
             ON viewer.jar_id=gameplay.jar_id AND viewer.user_id=$2 AND viewer.left_at IS NULL
           WHERE gameplay.id=$1 AND (gameplay.accuser_id=$3 OR gameplay.accused_id=$3)`,
          [report.reference.gameplayReportId, reporterUserId, report.targetUserId],
        );
        const referencedJarId = visibleGameplayReport.rows[0]?.jar_id;
        if (
          !referencedJarId ||
          (report.reference.jarId != null && report.reference.jarId !== referencedJarId)
        ) {
          throw new ModerationAuthorizationError();
        }
      }

      const receiptId = AbuseReportIdSchema.parse(genId("abr", { length: 32 }));
      const createdAt = this.clock();
      const sealedNarrative = report.narrative
        ? this.narrativeCipher.seal(report.narrative, receiptId)
        : null;
      await client.query(
        `INSERT INTO abuse_report
           (id,reporter_user_id,target_user_id,narrative_ciphertext,narrative_nonce,
            narrative_key_version,referenced_jar_id,referenced_gameplay_report_id,status,
            created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted',$9,$9)`,
        [
          receiptId,
          reporterUserId,
          report.targetUserId,
          sealedNarrative?.ciphertext ?? null,
          sealedNarrative?.nonce ?? null,
          sealedNarrative?.keyVersion ?? null,
          report.reference?.jarId ?? null,
          report.reference?.gameplayReportId ?? null,
          createdAt,
        ],
      );
      await client.query(
        `INSERT INTO abuse_report_audit_event
           (id,abuse_report_id,event_type,actor_user_id,created_at)
         VALUES ($1,$2,'submitted',$3,$4)`,
        [genId("mae", { length: 32 }), receiptId, reporterUserId, createdAt],
      );
      await client.query("COMMIT");
      return AbuseReportReceiptSchema.parse({ receiptId, status: "received" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

let installedModerationStore: ModerationSubmissionStore | undefined;

export function installModerationStore(store: ModerationSubmissionStore): void {
  installedModerationStore = store;
}

export function moderationStore(): ModerationSubmissionStore {
  if (!installedModerationStore) throw new Error("moderation store is not configured");
  return installedModerationStore;
}
